-- Tarelka: авторизация и серверное хранение.
-- Миграция создаёт пользовательские таблицы и включает RLS по user_id.
-- Решения: docs/prd-prototype.md §8.2, docs/architecture.md §8.
-- Секреты и ключи в этом файле не хранятся.

-- Профиль пользователя: серверная копия Profile из localStorage.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  onboarded boolean not null default false,
  diet text not null default 'none'
    check (diet in ('none', 'protein', 'light', 'gentle')),
  allergies text[] not null default '{}'
    check (
      allergies <@ array['gluten', 'nuts', 'milk', 'eggs', 'fish', 'soy']::text[]
      and array_position(allergies, null) is null
    ),
  people smallint not null default 4
    check (people in (2, 4, 6)),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Профиль: онбординг, категория питания, аллергии, порции.';

-- Одна активная неделя на пользователя. Структура days проверяется триггером ниже.
create table if not exists public.week_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  days jsonb not null default '[
    {"breakfast": null, "lunch": null, "dinner": null},
    {"breakfast": null, "lunch": null, "dinner": null},
    {"breakfast": null, "lunch": null, "dinner": null},
    {"breakfast": null, "lunch": null, "dinner": null},
    {"breakfast": null, "lunch": null, "dinner": null},
    {"breakfast": null, "lunch": null, "dinner": null},
    {"breakfast": null, "lunch": null, "dinner": null}
  ]'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.week_plans is 'Активная неделя: 7 дней по три слота; id рецепта или null.';

-- Проверка формы плана: ровно 7 дней, в каждом три известных слота.
create or replace function public.validate_week_plan()
returns trigger
language plpgsql
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

create trigger week_plans_validate
before insert or update of days on public.week_plans
for each row execute function public.validate_week_plan();

-- Отметки покупок. Ключ не зависит от количества, поэтому переживает смену порций.
create table if not exists public.checked_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  done boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, key),
  constraint checked_items_key_format check (
    key ~ '^plan\|[^|]+\|[^|]+\|[^|]+$'
    or key ~ '^manual\|[A-Za-z0-9_-]+$'
  )
);

comment on table public.checked_items is 'Отметки купленного: plan|отдел|название|единица или manual|id.';

-- Ручные позиции списка покупок.
create table if not exists public.manual_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 80),
  amount text not null default '' check (char_length(amount) <= 40),
  dept text not null default 'other'
    check (dept in ('veg', 'meat', 'dairy', 'pantry', 'spices', 'frozen', 'other')),
  source text not null default 'вручную'
    check (source in ('вручную', 'из рецепта')),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

comment on table public.manual_items is 'Ручные позиции: не исчезают при изменении плана.';

-- Признак одноразового импорта localStorage при первом входе.
create table if not exists public.imports (
  user_id uuid primary key references auth.users(id) on delete cascade,
  imported_at timestamptz not null default now(),
  source text not null default 'localStorage:v1'
);

comment on table public.imports is 'Одна запись на пользователя: импорт локального состояния уже выполнен.';

-- Обновление updated_at при изменении строк.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

create trigger week_plans_touch_updated_at
before update on public.week_plans
for each row execute function public.touch_updated_at();

create trigger checked_items_touch_updated_at
before update on public.checked_items
for each row execute function public.touch_updated_at();

create trigger manual_items_touch_updated_at
before update on public.manual_items
for each row execute function public.touch_updated_at();

-- Права: только аутентифицированные пользователи, доступ — только к своим строкам.
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.week_plans,
  public.checked_items,
  public.manual_items,
  public.imports
to authenticated;

revoke all on
  public.profiles,
  public.week_plans,
  public.checked_items,
  public.manual_items,
  public.imports
from anon;

alter table public.profiles enable row level security;
alter table public.week_plans enable row level security;
alter table public.checked_items enable row level security;
alter table public.manual_items enable row level security;
alter table public.imports enable row level security;

create policy own_rows on public.profiles
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy own_rows on public.week_plans
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy own_rows on public.checked_items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy own_rows on public.manual_items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy own_rows on public.imports
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
