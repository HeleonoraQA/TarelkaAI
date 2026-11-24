-- Tarelka: индексы под внешние ключи каталога.
-- Убрано предупреждение performance advisor unindexed_foreign_keys.

create index if not exists ingredients_department_key_idx
  on public.ingredients (department_key);

create index if not exists recipe_allergens_allergen_key_idx
  on public.recipe_allergens (allergen_key);

create index if not exists recipe_categories_category_key_idx
  on public.recipe_categories (category_key);

create index if not exists recipe_ingredients_ingredient_name_idx
  on public.recipe_ingredients (ingredient_name);

create index if not exists recipe_tags_tag_name_idx
  on public.recipe_tags (tag_name);
