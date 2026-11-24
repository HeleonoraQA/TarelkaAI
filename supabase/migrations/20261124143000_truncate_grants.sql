-- Tarelka: отзыв права TRUNCATE у клиентских ролей.
-- RLS не ограничивает TRUNCATE: роль с этим правом может очистить таблицу целиком,
-- минуя политики по user_id и политику чтения каталога.
-- Права service_role не изменяются.

revoke truncate on
  public.profiles,
  public.week_plans,
  public.checked_items,
  public.manual_items,
  public.imports,
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
from anon, authenticated;
