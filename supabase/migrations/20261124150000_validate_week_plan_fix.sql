-- Tarelka: исправление триггера проверки недельного плана.
-- jsonb_object_length() не существует в PostgreSQL: заменяем подсчётом ключей.
create or replace function public.validate_week_plan()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  day_value jsonb;
  slot_key text;
  slot_id text;
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
       or (select count(*) from jsonb_object_keys(day_value)) <> 3 then
      raise exception 'Каждый день должен содержать breakfast, lunch и dinner';
    end if;

    foreach slot_key in array array['breakfast', 'lunch', 'dinner'] loop
      slot_id := nullif(day_value ->> slot_key, '');
      if slot_id is not null
         and not exists (select 1 from recipes where id = slot_id) then
        raise exception 'Неизвестный id рецепта: %', slot_id;
      end if;
    end loop;
  end loop;

  return new;
end;
$$;
