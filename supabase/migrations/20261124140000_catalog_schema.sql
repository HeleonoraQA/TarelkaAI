-- Tarelka: нормализованный каталог рецептов из js/data.js.
-- Источник истины — Postgres; js/data.js остаётся офлайн-резервом.
-- Решения: docs/prd-prototype.md §8.3, docs/architecture.md §9.

-- Отделы покупок: порядок фиксированный, как в data.js.
create table if not exists public.departments (
  key text primary key
    check (key in ('veg', 'meat', 'dairy', 'pantry', 'spices', 'frozen', 'other')),
  title text not null,
  sort_order smallint not null unique check (sort_order between 1 and 7)
);

comment on table public.departments is 'Отделы покупок; sort_order задаёт порядок в списке.';

-- Категории питания: none не фильтрует каталог, поэтому в таблице только три значения.
create table if not exists public.diet_categories (
  key text primary key check (key in ('protein', 'light', 'gentle'))
);

-- Аллергены: фиксированный список из шести.
create table if not exists public.allergens (
  key text primary key
    check (key in ('gluten', 'nuts', 'milk', 'eggs', 'fish', 'soy'))
);

-- Теги рецепта: произвольные метки из каталога (Завтрак, Обед, Быстро и др.).
create table if not exists public.tags (
  name text primary key
);

-- Ингредиент: название — ключ, отдел привязан через ingredientCategories.
create table if not exists public.ingredients (
  name text primary key,
  department_key text not null default 'other'
    references public.departments(key) on update cascade
);

comment on table public.ingredients is 'Ингредиенты; department_key заменяет ingredientCategories из data.js.';

-- Рецепт: id — slug из data.js, image — путь к локальному SVG.
create table if not exists public.recipes (
  id text primary key,
  title text not null,
  time integer not null check (time > 0),
  servings smallint not null check (servings > 0),
  intro text not null,
  image text not null,
  created_at timestamptz not null default now()
);

-- Шаги приготовления: порядок задаётся step_no.
create table if not exists public.recipe_steps (
  recipe_id text not null references public.recipes(id) on delete cascade,
  step_no smallint not null check (step_no > 0),
  body text not null,
  primary key (recipe_id, step_no)
);

-- Состав рецепта: amount остаётся строкой, чтобы сохранить '0,5' и '' («по вкусу»).
create table if not exists public.recipe_ingredients (
  recipe_id text not null references public.recipes(id) on delete cascade,
  ingredient_name text not null references public.ingredients(name),
  amount text not null default '',
  unit text not null,
  position smallint not null check (position > 0),
  primary key (recipe_id, ingredient_name)
);

-- Связи «многие ко многим» между рецептом и справочниками.
create table if not exists public.recipe_tags (
  recipe_id text not null references public.recipes(id) on delete cascade,
  tag_name text not null references public.tags(name) on delete cascade,
  primary key (recipe_id, tag_name)
);

create table if not exists public.recipe_categories (
  recipe_id text not null references public.recipes(id) on delete cascade,
  category_key text not null references public.diet_categories(key) on delete cascade,
  primary key (recipe_id, category_key)
);

create table if not exists public.recipe_allergens (
  recipe_id text not null references public.recipes(id) on delete cascade,
  allergen_key text not null references public.allergens(key) on delete cascade,
  primary key (recipe_id, allergen_key)
);

-- Расширяем проверку плана: невалидные id рецептов больше не попадают в days.
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
       or jsonb_object_length(day_value) <> 3 then
      raise exception 'Каждый день должен содержать breakfast, lunch и dinner';
    end if;

    foreach slot_key in array array['breakfast', 'lunch', 'dinner'] loop
      slot_id := nullif(day_value->>slot_key, '');
      if slot_id is not null
         and not exists (select 1 from recipes where id = slot_id) then
        raise exception 'Неизвестный id рецепта: %', slot_id;
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

-- Каталог читают все, меняют только service_role и миграции.
grant usage on schema public to anon, authenticated;
grant select on
  public.departments,
  public.diet_categories,
  public.allergens,
  public.tags,
  public.ingredients,
  public.recipes,
  public.recipe_steps,
  public.recipe_ingredients,
  public.recipe_tags,
  public.recipe_categories,
  public.recipe_allergens
to anon, authenticated;

alter table public.departments enable row level security;
alter table public.diet_categories enable row level security;
alter table public.allergens enable row level security;
alter table public.tags enable row level security;
alter table public.ingredients enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_steps enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_tags enable row level security;
alter table public.recipe_categories enable row level security;
alter table public.recipe_allergens enable row level security;

create policy catalog_read on public.departments
  for select to anon, authenticated using (true);
create policy catalog_read on public.diet_categories
  for select to anon, authenticated using (true);
create policy catalog_read on public.allergens
  for select to anon, authenticated using (true);
create policy catalog_read on public.tags
  for select to anon, authenticated using (true);
create policy catalog_read on public.ingredients
  for select to anon, authenticated using (true);
create policy catalog_read on public.recipes
  for select to anon, authenticated using (true);
create policy catalog_read on public.recipe_steps
  for select to anon, authenticated using (true);
create policy catalog_read on public.recipe_ingredients
  for select to anon, authenticated using (true);
create policy catalog_read on public.recipe_tags
  for select to anon, authenticated using (true);
create policy catalog_read on public.recipe_categories
  for select to anon, authenticated using (true);
create policy catalog_read on public.recipe_allergens
  for select to anon, authenticated using (true);
