-- Tarelka: серверный API на Postgres-функциях (RPC через Supabase).
-- Контракт описан в docs/architecture.md §10. Все функции работают с auth.uid().

-- Разбор строки количества: пустое и нечисловое значение означают «по вкусу».
create or replace function public.shopping_parse_amount(p_amount text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_amount is null or btrim(p_amount) = '' then null
    else (
      select case
        when v ~ '^[+-]?([0-9]+([.,][0-9]*)?|[.,][0-9]+)$'
          then replace(v, ',', '.')::numeric
        else null
      end
      from (select btrim(p_amount) as v) as parsed
    )
  end;
$$;

-- Округление по единицам из docs/spec.md §5.1.
create or replace function public.shopping_round(p_value numeric, p_unit text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_unit in ('шт', 'шт.', 'зуб.', 'банка', 'ломтика')
      then greatest(1::numeric, ceil(coalesce(p_value, 0) - 0.000000001))
    when p_unit in ('г', 'мл')
      then greatest(5::numeric, round(coalesce(p_value, 0) / 5.0) * 5)
    when p_unit in ('ст. л.', 'ч. л.')
      then greatest(0.5::numeric, round(coalesce(p_value, 0) * 2) / 2)
    else round(coalesce(p_value, 0), 1)
  end;
$$;

-- Форматирование числа: десятичная запятая и не более одного знака после неё.
create or replace function public.format_shopping_amount(p_value numeric)
returns text
language sql
immutable
set search_path = public
as $$
  select replace(
    rtrim(rtrim(to_char(round(coalesce(p_value, 0), 1), 'FM9999999999999990.999'), '0'), '.'),
    '.', ','
  );
$$;

-- Проверка вошедшего пользователя: общая для всех пользовательских RPC.
create or replace function public.api_require_user()
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется вход в систему';
  end if;
  return v_uid;
end;
$$;

-- Приведение плана к 7 дням × 3 слота; неизвестные id рецептов становятся null.
create or replace function public.api_normalize_plan(p_days jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_result jsonb := '[]'::jsonb;
  v_day jsonb;
  v_entry jsonb;
  v_slot text;
  v_id text;
  i integer;
begin
  if p_days is null or jsonb_typeof(p_days) <> 'array' then
    raise exception 'План должен быть массивом';
  end if;

  for i in 0..6 loop
    v_day := case
      when i < jsonb_array_length(p_days) then p_days -> i
      else '{}'::jsonb
    end;
    if jsonb_typeof(v_day) <> 'object' then
      v_day := '{}'::jsonb;
    end if;

    v_entry := '{}'::jsonb;
    foreach v_slot in array array['breakfast', 'lunch', 'dinner'] loop
      v_id := nullif(btrim(coalesce(v_day ->> v_slot, '')), '');
      if v_id is not null
         and not exists (select 1 from public.recipes r where r.id = v_id) then
        v_id := null;
      end if;
      v_entry := v_entry || jsonb_build_object(v_slot, v_id);
    end loop;

    v_result := v_result || jsonb_build_array(v_entry);
  end loop;

  return v_result;
end;
$$;

-- Чтение плана: пустой план отдаётся без создания строки.
create or replace function public.api_get_plan()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
  v_days jsonb;
begin
  select days into v_days from public.week_plans where user_id = v_uid;
  return coalesce(v_days, public.api_normalize_plan('[]'::jsonb));
end;
$$;

-- Полная замена недели.
create or replace function public.api_set_plan(p_days jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
  v_days jsonb := public.api_normalize_plan(p_days);
begin
  insert into public.week_plans (user_id, days)
  values (v_uid, v_days)
  on conflict (user_id) do update set days = excluded.days;
  return v_days;
end;
$$;

-- Назначение или очистка одной ячейки.
create or replace function public.api_set_meal(
  p_day integer,
  p_slot text,
  p_recipe_id text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
  v_days jsonb;
  v_id text;
begin
  if p_day is null or p_day < 0 or p_day > 6 then
    raise exception 'День должен быть от 0 до 6';
  end if;
  if p_slot is null or p_slot not in ('breakfast', 'lunch', 'dinner') then
    raise exception 'Неизвестный слот приёма пищи';
  end if;

  v_id := nullif(btrim(coalesce(p_recipe_id, '')), '');
  if v_id is not null
     and not exists (select 1 from public.recipes r where r.id = v_id) then
    v_id := null;
  end if;

  select days into v_days from public.week_plans where user_id = v_uid;
  if v_days is null then
    v_days := public.api_normalize_plan('[]'::jsonb);
    insert into public.week_plans (user_id, days) values (v_uid, v_days);
  end if;

  v_days := jsonb_set(v_days, array[p_day::text, p_slot], to_jsonb(v_id));
  update public.week_plans set days = v_days where user_id = v_uid;
  return v_days;
end;
$$;

-- Сборка списка покупок из плана, профиля, ручных позиций и отметок.
create or replace function public.api_get_shopping()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
  v_people integer;
  v_days jsonb;
  v_result jsonb;
begin
  select people into v_people from public.profiles where user_id = v_uid;
  v_people := coalesce(v_people, 4);

  select days into v_days from public.week_plans where user_id = v_uid;
  v_days := coalesce(v_days, public.api_normalize_plan('[]'::jsonb));

  with plan_lines as (
    select
      'plan|' || coalesce(i.department_key, 'other') || '|' ||
        ri.ingredient_name || '|' || ri.unit as key,
      coalesce(i.department_key, 'other') as dept,
      ri.ingredient_name as name,
      ri.unit as unit,
      public.shopping_parse_amount(ri.amount) * v_people::numeric / r.servings as scaled_value,
      d.ord * 100 + s.ord * 10 + ri.position as ord
    from jsonb_array_elements(v_days) with ordinality as d(day_value, ord)
    cross join unnest(array['breakfast', 'lunch', 'dinner']) with ordinality as s(slot, ord)
    cross join lateral (select d.day_value ->> s.slot as recipe_id) as slot_value
    join public.recipes r on r.id = slot_value.recipe_id
    join public.recipe_ingredients ri on ri.recipe_id = r.id
    left join public.ingredients i on i.name = ri.ingredient_name
  ),
  plan_totals as (
    select
      key,
      min(dept) as dept,
      min(name) as name,
      min(unit) as unit,
      sum(scaled_value) as total,
      bool_or(scaled_value is null) as by_taste,
      bool_or(scaled_value is not null) as has_amount,
      min(ord) as ord
    from plan_lines
    group by key
  ),
  manual_lines as (
    select
      'manual|' || m.id as key,
      m.dept,
      m.name,
      m.amount as amount_text,
      m.source,
      m.id as manual_id,
      1000000 + row_number() over (order by m.updated_at, m.id) as ord
    from public.manual_items m
    where m.user_id = v_uid
  ),
  lines as (
    select
      p.key,
      p.dept,
      p.name,
      p.unit,
      case
        when p.has_amount then
          public.format_shopping_amount(public.shopping_round(p.total, p.unit)) ||
          case when p.unit <> '' then ' ' || p.unit else '' end
        else coalesce(nullif(p.unit, ''), 'по вкусу')
      end as amount_text,
      null::text as manual_id,
      'из плана'::text as source,
      p.ord
    from plan_totals p
    union all
    select
      m.key,
      m.dept,
      m.name,
      '' as unit,
      m.amount_text,
      m.manual_id,
      m.source,
      m.ord
    from manual_lines m
  ),
  joined as (
    select
      coalesce(d.key, 'other') as dept_key,
      coalesce(d.title, (select title from public.departments where key = 'other')) as dept_title,
      coalesce(d.sort_order, 999) as sort_order,
      l.key,
      l.name,
      l.source,
      l.manual_id,
      l.amount_text,
      l.ord,
      coalesce(c.done, false) as done
    from lines l
    left join public.departments d on d.key = l.dept
    left join public.checked_items c
      on c.user_id = v_uid and c.key = l.key and c.done
  )
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'key', g.dept_key,
          'title', g.dept_title,
          'items', g.items
        ) order by g.sort_order
      )
      from (
        select
          dept_key,
          dept_title,
          sort_order,
          jsonb_agg(
            jsonb_build_object(
              'key', key,
              'name', name,
              'dept', dept_key,
              'source', source,
              'manualId', manual_id,
              'amountText', amount_text,
              'done', done
            ) order by ord
          ) as items
        from joined
        group by dept_key, dept_title, sort_order
      ) as g
    ),
    '[]'::jsonb
  )
  into v_result;

  return v_result;
end;
$$;

-- Добавление ручной позиции; возвращает её id.
create or replace function public.api_add_manual(
  p_name text,
  p_amount text default '',
  p_dept text default 'other',
  p_source text default 'вручную'
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
  v_id text;
  v_dept text;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Название позиции не может быть пустым';
  end if;

  if p_dept is null or not exists (select 1 from public.departments d where d.key = p_dept) then
    v_dept := 'other';
  else
    v_dept := p_dept;
  end if;

  v_id := 'm' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text ||
          lpad(floor(random() * 1000)::integer::text, 3, '0');

  insert into public.manual_items (user_id, id, name, amount, dept, source)
  values (v_uid, v_id, btrim(p_name), coalesce(p_amount, ''), v_dept,
          coalesce(p_source, 'вручную'));

  return v_id;
end;
$$;

-- Удаление ручной позиции вместе с её отметкой.
create or replace function public.api_remove_manual(p_id text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
  v_found boolean;
begin
  with removed as (
    delete from public.manual_items
    where user_id = v_uid and id = p_id
    returning 1
  )
  select count(*) > 0 into v_found from removed;

  delete from public.checked_items
  where user_id = v_uid and key = 'manual|' || p_id;

  return coalesce(v_found, false);
end;
$$;

-- Постановка или снятие отметки.
create or replace function public.api_set_checked(
  p_key text,
  p_done boolean default true
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'Ключ отметки не может быть пустым';
  end if;

  insert into public.checked_items (user_id, key, done)
  values (v_uid, p_key, coalesce(p_done, true))
  on conflict (user_id, key) do update set done = excluded.done;

  return true;
end;
$$;

-- Полное удаление отметки.
create or replace function public.api_unset_checked(p_key text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := public.api_require_user();
begin
  delete from public.checked_items
  where user_id = v_uid and key = p_key;
  return found;
end;
$$;

-- Права: клиентские вызовы доступны только вошедшим пользователям.
revoke all on function public.api_get_plan() from public, anon;
revoke all on function public.api_set_plan(jsonb) from public, anon;
revoke all on function public.api_set_meal(integer, text, text) from public, anon;
revoke all on function public.api_get_shopping() from public, anon;
revoke all on function public.api_add_manual(text, text, text, text) from public, anon;
revoke all on function public.api_remove_manual(text) from public, anon;
revoke all on function public.api_set_checked(text, boolean) from public, anon;
revoke all on function public.api_unset_checked(text) from public, anon;
revoke all on function public.api_normalize_plan(jsonb) from public, anon;
revoke all on function public.api_require_user() from public, anon;
revoke all on function public.shopping_parse_amount(text) from public, anon;
revoke all on function public.shopping_round(numeric, text) from public, anon;
revoke all on function public.format_shopping_amount(numeric) from public, anon;

grant execute on function public.api_get_plan() to authenticated, service_role;
grant execute on function public.api_set_plan(jsonb) to authenticated, service_role;
grant execute on function public.api_set_meal(integer, text, text) to authenticated, service_role;
grant execute on function public.api_get_shopping() to authenticated, service_role;
grant execute on function public.api_add_manual(text, text, text, text) to authenticated, service_role;
grant execute on function public.api_remove_manual(text) to authenticated, service_role;
grant execute on function public.api_set_checked(text, boolean) to authenticated, service_role;
grant execute on function public.api_unset_checked(text) to authenticated, service_role;
grant execute on function public.api_normalize_plan(jsonb) to authenticated, service_role;
grant execute on function public.api_require_user() to authenticated, service_role;
grant execute on function public.shopping_parse_amount(text) to authenticated, service_role;
grant execute on function public.shopping_round(numeric, text) to authenticated, service_role;
grant execute on function public.format_shopping_amount(numeric) to authenticated, service_role;
