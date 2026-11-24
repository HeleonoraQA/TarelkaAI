-- Tarelka: исправление очистки ячейки плана.
-- to_jsonb(NULL) возвращает SQL NULL, а не jsonb null: jsonb_set поэтому обнулял весь план.
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

  v_days := jsonb_set(
    v_days,
    array[p_day::text, p_slot],
    case when v_id is null then 'null'::jsonb else to_jsonb(v_id) end
  );
  update public.week_plans set days = v_days where user_id = v_uid;
  return v_days;
end;
$$;

-- Права сохраняются при замене функции: сбрасываем и выдаём заново.
revoke all on function public.api_set_meal(integer, text, text) from public, anon;
grant execute on function public.api_set_meal(integer, text, text) to authenticated, service_role;
