-- Tarelka: устранение предупреждений advisory после миграции auth/RLS.
-- 1) Фиксируем search_path у функций.
-- 2) Оборачиваем auth.uid() в (select ...) в политиках, чтобы не перевычислять его на строку.

create or replace function public.validate_week_plan()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  day_value jsonb;
begin
  if jsonb_typeof(new.days) <> 'array' then
    raise exception 'План должен быть массивом';
  end if;

  if jsonb_array_length(new.days) <> 7 then
    raise exception 'План должен содержать ровно 7 дней';
  end if;

  for day_value in select value from jsonb_array_elements(new.days) loop
    if jsonb_typeof(day_value) <> 'object' then
      raise exception 'Каждый день должен быть объектом';
    end if;

    if not (day_value ?& array['breakfast', 'lunch', 'dinner'])
       or jsonb_object_length(day_value) <> 3 then
      raise exception 'Каждый день должен содержать breakfast, lunch и dinner';
    end if;
  end loop;

  return new;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Политики пересоздаём с подзапросом: (select auth.uid()) вычисляется один раз.
drop policy if exists own_rows on public.profiles;
create policy own_rows on public.profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.week_plans;
create policy own_rows on public.week_plans
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.checked_items;
create policy own_rows on public.checked_items
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.manual_items;
create policy own_rows on public.manual_items
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists own_rows on public.imports;
create policy own_rows on public.imports
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
