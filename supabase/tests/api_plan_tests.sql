-- Tarelka: pgTAP-тесты CRUD плана через RPC.
--
-- Запускать как один скрипт после установки pgTAP:
--   все проверки идут в транзакции с rollback, пробные данные не сохраняются.
-- Ожидаемый результат: 16 тестов, все ok.

begin;

set search_path to extensions, public;

select plan(16);

-- Три вымышленных пользователя: A и B для проверки изоляции, C для триггера.
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', 'api-a@example.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', 'api-b@example.test'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'authenticated', 'authenticated', 'api-c@example.test');

insert into public.profiles (user_id, people) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 6);

-- Эталон нормализованного плана.
create temp table tarelka_expected(days jsonb) on commit drop;
insert into tarelka_expected values (
  '[{"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null},
    {"breakfast":null,"lunch":null,"dinner":null}]'::jsonb
);

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);

-- 1. Чтение до сохранения возвращает пустую неделю.
select is(
  public.api_get_plan(),
  (select days from tarelka_expected),
  'api_get_plan: пустой план на 7 дней'
);

-- 2. Замена нормализует длину и неизвестные id рецептов.
select is(
  public.api_set_plan('[{"breakfast":"нет-такого","lunch":"нет-такого-2","dinner":null}]'::jsonb),
  (select days from tarelka_expected),
  'api_set_plan: короткий план дополняется, неизвестный id становится null'
);

-- 3. Записанный план читается обратно.
select is(
  public.api_get_plan(),
  (select days from tarelka_expected),
  'api_get_plan: возвращает сохранённый план'
);

-- 4. В плане ровно 7 дней.
select is(
  jsonb_array_length(public.api_get_plan()),
  7,
  'api_get_plan: длина массива 7'
);

-- 5. Назначение ячейки.
select is(
  public.api_set_meal(0, 'breakfast', 'oatmeal') -> 0 ->> 'breakfast',
  'oatmeal',
  'api_set_meal: назначает рецепт в ячейку'
);

-- 6. Очистка ячейки.
select ok(
  public.api_set_meal(0, 'breakfast', null) -> 0 ->> 'breakfast' is null,
  'api_set_meal: null очищает ячейку'
);

-- 7. Неизвестный слот запрещён.
select throws_ok(
  $$select public.api_set_meal(0, 'brunch', null)$$,
  'P0001',
  null,
  'api_set_meal: ошибка на неизвестном слоте'
);

-- 8. День вне диапазона запрещён.
select throws_ok(
  $$select public.api_set_meal(7, 'lunch', null)$$,
  'P0001',
  null,
  'api_set_meal: ошибка на дне вне 0..6'
);

-- 9. Неизвестный id рецепта при точечном назначении становится null.
select ok(
  public.api_set_meal(1, 'lunch', 'нет-такого') -> 1 ->> 'lunch' is null,
  'api_set_meal: неизвестный id рецепта очищает ячейку'
);

-- 10. Изоляция пользователей: план B не виден A.
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
select public.api_set_plan(
  '[{"breakfast":"oatmeal","lunch":null,"dinner":null}]'::jsonb
);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
select ok(
  public.api_get_plan() -> 0 ->> 'breakfast' is null,
  'api_get_plan: пользователь A не видит план B'
);

-- 11. anon не может вызывать RPC.
select is(
  has_function_privilege('anon', 'public.api_get_plan()'::regprocedure, 'EXECUTE'),
  false,
  'anon: нет EXECUTE на api_get_plan'
);

-- 12. authenticated может вызывать RPC.
select is(
  has_function_privilege('authenticated', 'public.api_get_plan()'::regprocedure, 'EXECUTE'),
  true,
  'authenticated: есть EXECUTE на api_get_plan'
);

-- 13. Вызов без вошедшего пользователя запрещён.
select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$select public.api_get_plan()$$,
  'P0001',
  null,
  'api_get_plan: ошибка без auth.uid()'
);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);

-- 14. Триггер отклоняет день без трёх слотов.
select throws_ok(
  $$insert into public.week_plans (user_id, days)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
            '[{"breakfast":null,"lunch":null}]'::jsonb)$$,
  'P0001',
  null,
  'week_plans_validate: день без dinner отклонён'
);

-- 15. Триггер принимает корректный план.
select lives_ok(
  $$insert into public.week_plans (user_id, days)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
            '[{"breakfast":null,"lunch":null,"dinner":null},
              {"breakfast":null,"lunch":null,"dinner":null},
              {"breakfast":null,"lunch":null,"dinner":null},
              {"breakfast":null,"lunch":null,"dinner":null},
              {"breakfast":null,"lunch":null,"dinner":null},
              {"breakfast":null,"lunch":null,"dinner":null},
              {"breakfast":null,"lunch":null,"dinner":null}]'::jsonb)$$,
  'week_plans_validate: корректный план принят'
);

-- 16. Триггер отклоняет неизвестный id рецепта.
select throws_ok(
  $$update public.week_plans
      set days = jsonb_set(days, '{0,breakfast}', '"нет-рецепта"'::jsonb)
    where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid$$,
  'P0001',
  null,
  'week_plans_validate: неизвестный id рецепта отклонён'
);

select * from finish();

rollback;
