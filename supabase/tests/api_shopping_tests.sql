-- Tarelka: pgTAP-тесты сборки списка покупок через RPC.
--
-- Запускать как один скрипт после установки pgTAP:
--   все проверки идут в транзакции с rollback, пробные данные не сохраняются.
-- Ожидаемый результат: 37 тестов, все ok.

begin;

set search_path to extensions, public;

select plan(37);

-- Округление по единицам из docs/spec.md §5.1.
select is(public.shopping_round(2.0000000005, 'шт'), 2::numeric, 'шт: epsilon не вызывает лишнего округления вверх');
select is(public.shopping_round(0.2, 'шт'), 1::numeric, 'шт: минимум 1');
select is(public.shopping_round(1.2, 'зуб.'), 2::numeric, 'зуб.: вверх до целого');
select is(public.shopping_round(1.2, 'банка'), 2::numeric, 'банка: вверх до целого');
select is(public.shopping_round(1.2, 'ломтика'), 2::numeric, 'ломтика: вверх до целого');
select is(public.shopping_round(1.2, 'шт.'), 2::numeric, 'шт.: вверх до целого');
select is(public.shopping_round(3, 'г'), 5::numeric, 'г: минимум 5');
select is(public.shopping_round(12, 'г'), 10::numeric, 'г: округляется до 10');
select is(public.shopping_round(13, 'г'), 15::numeric, 'г: округляется до 15');
select is(public.shopping_round(102, 'мл'), 100::numeric, 'мл: округляется до 100');
select is(public.shopping_round(0.2, 'ст. л.'), 0.5::numeric, 'ст. л.: минимум 0,5');
select is(public.shopping_round(1.3, 'ч. л.'), 1.5::numeric, 'ч. л.: до 0,5');
select is(public.shopping_round(1.24, 'щепотка'), 1.2::numeric, 'прочие единицы: один знак');

-- Разбор и форматирование количества.
select is(public.shopping_parse_amount('0,5'), 0.5, 'parse: десятичная запятая');
select ok(public.shopping_parse_amount('') is null, 'parse: пустая строка');
select ok(public.shopping_parse_amount('по вкусу') is null, 'parse: не число');
select is(public.format_shopping_amount(5), '5', 'format: целое без дробной части');
select is(public.format_shopping_amount(0.5), '0,5', 'format: десятичная запятая');

-- Вымышленные пользователи: A собирает список, B не должен его видеть.
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', 'shop-a@example.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', 'shop-b@example.test');

insert into public.profiles (user_id, people) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 4),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 2);

-- Два тестовых рецепта на 2 порции: множитель для A равен 2.
-- Повторяющиеся ингредиенты приходят из разных рецептов плана:
-- в каталоге (recipe_id, ingredient_name) — первичный ключ.
insert into public.recipes (id, title, time, servings, intro, image) values
  ('tarelka-api-test', 'Тестовый рецепт', 10, 2, 'Тест', 'test.svg'),
  ('tarelka-api-test-2', 'Второй тестовый рецепт', 10, 2, 'Тест', 'test2.svg');

insert into public.ingredients (name, department_key) values
  ('ТестТоматы', 'veg'),
  ('ТестЧеснок', 'veg'),
  ('ТестМука', 'pantry'),
  ('ТестМасло', 'pantry'),
  ('ТестСоль', 'spices'),
  ('ТестПерец', 'spices'),
  ('ТестСода', 'other');

insert into public.recipe_ingredients (recipe_id, ingredient_name, amount, unit, position) values
  ('tarelka-api-test', 'ТестТоматы', '3', 'шт', 1),
  ('tarelka-api-test', 'ТестМука', '100', 'г', 2),
  ('tarelka-api-test', 'ТестСоль', '', 'по вкусу', 3),
  ('tarelka-api-test', 'ТестЧеснок', '1', 'зуб.', 4),
  ('tarelka-api-test', 'ТестМасло', '1', 'ст. л.', 5),
  ('tarelka-api-test', 'ТестПерец', '0,5', 'ч. л.', 6),
  ('tarelka-api-test', 'ТестСода', '2', 'щепотка', 7),
  ('tarelka-api-test-2', 'ТестТоматы', '3', 'шт', 1),
  ('tarelka-api-test-2', 'ТестМука', '50', 'г', 2);

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);

create temp table tarelka_empty(days jsonb) on commit drop;
insert into tarelka_empty values (
  '[{"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null}]'::jsonb
);

select public.api_set_plan(
  jsonb_set(
    jsonb_set((select days from tarelka_empty), '{0,breakfast}', '"tarelka-api-test"'::jsonb),
    '{0,lunch}', '"tarelka-api-test-2"'::jsonb
  )
);

-- Вспомогательные функции для чтения позиций собранного списка.
create function pg_temp.shopping_item(p_key text) returns jsonb
language sql stable as $$
  select it.value
  from jsonb_array_elements(public.api_get_shopping()) as grp(value)
  cross join lateral jsonb_array_elements(grp.value -> 'items') as it(value)
  where grp.value ->> 'key' = split_part(p_key, '|', 2)
    and it.value ->> 'key' = p_key
  limit 1
$$;

create function pg_temp.shopping_by_name(p_name text) returns jsonb
language sql stable as $$
  select it.value
  from jsonb_array_elements(public.api_get_shopping()) as grp(value)
  cross join lateral jsonb_array_elements(grp.value -> 'items') as it(value)
  where it.value ->> 'name' = p_name
  limit 1
$$;

-- Дедупликация: сырые значения складываются до округления: (3 + 3) × 2 = 12.
select is(
  pg_temp.shopping_item('plan|veg|ТестТоматы|шт') ->> 'amountText',
  '12 шт',
  'дубли по name+unit+dept суммируются до округления'
);

select is(
  pg_temp.shopping_item('plan|pantry|ТестМука|г') ->> 'amountText',
  '300 г',
  'граммы: (100 + 50) × 2 округляется до 300'
);

select is(
  pg_temp.shopping_item('plan|spices|ТестСоль|по вкусу') ->> 'amountText',
  'по вкусу',
  'пустое количество выводится как по вкусу'
);

select is(
  pg_temp.shopping_item('plan|veg|ТестЧеснок|зуб.') ->> 'amountText',
  '2 зуб.',
  'зуб.: 1 × 2 округляется вверх до целого'
);

select is(
  pg_temp.shopping_item('plan|pantry|ТестМасло|ст. л.') ->> 'amountText',
  '2 ст. л.',
  'ст. л.: 1 × 2 округляется до 0,5'
);

select is(
  pg_temp.shopping_item('plan|spices|ТестПерец|ч. л.') ->> 'amountText',
  '1 ч. л.',
  'ч. л.: 0,5 × 2 округляется до 0,5'
);

select is(
  pg_temp.shopping_item('plan|other|ТестСода|щепотка') ->> 'amountText',
  '4 щепотка',
  'ингредиент отдела other попадает в группу other'
);

select is(
  (select jsonb_agg(grp.value -> 'key' order by grp.ord)
   from jsonb_array_elements(public.api_get_shopping()) with ordinality as grp(value, ord)),
  '["veg","pantry","spices","other"]'::jsonb,
  'группы идут в порядке departments.sort_order, пустые отсутствуют'
);

select is(
  pg_temp.shopping_item('plan|veg|ТестТоматы|шт') ->> 'done',
  'false',
  'без отметки done = false'
);

-- Отметки: ставятся, снимаются и не зависят от количества.
select public.api_set_checked('plan|veg|ТестТоматы|шт', true);
select is(
  pg_temp.shopping_item('plan|veg|ТестТоматы|шт') ->> 'done',
  'true',
  'api_set_checked: отметка видна в списке'
);

select public.api_unset_checked('plan|veg|ТестТоматы|шт');
select is(
  pg_temp.shopping_item('plan|veg|ТестТоматы|шт') ->> 'done',
  'false',
  'api_unset_checked: отметка удалена'
);

select public.api_set_checked('plan|veg|ТестТоматы|шт', true);
select public.api_set_checked('plan|veg|ТестТоматы|шт', false);
select is(
  pg_temp.shopping_item('plan|veg|ТестТоматы|шт') ->> 'done',
  'false',
  'api_set_checked(false): отметка снята'
);

-- Ручные позиции не округляются и удаляются вместе с отметкой.
create temp table tarelka_manual(id text) on commit drop;
insert into tarelka_manual
select public.api_add_manual('Бумажные полотенца', '2 банки');

select ok(
  (select id from tarelka_manual) like 'm%',
  'api_add_manual: возвращает id ручной позиции'
);

select is(
  pg_temp.shopping_by_name('Бумажные полотенца') ->> 'amountText',
  '2 банки',
  'ручная позиция сохраняет amount как текст'
);

select is(
  public.api_remove_manual((select id from tarelka_manual)),
  true,
  'api_remove_manual: позиция была удалена'
);

select ok(
  pg_temp.shopping_by_name('Бумажные полотенца') is null,
  'api_remove_manual: позиция исчезла из списка'
);

select ok(
  not exists (
    select 1 from public.checked_items
    where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
      and key = 'manual|' || (select id from tarelka_manual)
  ),
  'api_remove_manual: отметка удалённой позиции тоже удалена'
);

-- Отметка переживает пересборку плана.
select public.api_set_checked('plan|veg|ТестЧеснок|зуб.', true);
select public.api_set_plan((select days from tarelka_empty));
select ok(
  exists (
    select 1 from public.checked_items
    where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
      and key = 'plan|veg|ТестЧеснок|зуб.'
      and done
  ),
  'отметка остаётся после замены плана'
);

-- Другой пользователь не видит чужой список.
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
select is(
  public.api_get_shopping(),
  '[]'::jsonb,
  'api_get_shopping: пользователь B видит пустой список'
);

select * from finish();

rollback;
