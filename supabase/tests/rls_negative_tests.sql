-- Tarelka: негативные тесты доступа к RLS-политикам.
--
-- Запускать как один скрипт от имени postgres/service-роли:
--   все проверки идут в транзакции с rollback, постоянных изменений не будет.
--
-- Ожидаемый результат: все строки имеют passed = true (26 проверок).
--
-- Временное ограничение: триггер week_plans_validate отключён внутри транзакции,
-- потому что он вызывает несуществующую функцию jsonb_object_length().
-- После исправления триггера эту строку можно удалить.

begin;

create temp table tarelka_rls_probe(test text, passed boolean, detail text) on commit drop;

-- Сломанный триггер мешает подготовить тестовые строки плана.
alter table public.week_plans disable trigger week_plans_validate;

do $$
declare
  -- Два вымышленных пользователя: A — от чьего имени идём, B — чужой владелец.
  ua uuid := '11111111-1111-1111-1111-111111111111';
  ub uuid := '22222222-2222-2222-2222-222222222222';
  v_temp text := pg_my_temp_schema()::regnamespace::text;
  i int;
  n int;

  -- 1. anon не должен читать пользовательские таблицы: ожидаем ошибку.
  u_names text[] := array[
    'anon: SELECT profiles', 'anon: SELECT week_plans', 'anon: SELECT checked_items',
    'anon: SELECT manual_items', 'anon: SELECT imports'
  ];
  u_queries text[] := array[
    'select count(*) from public.profiles', 'select count(*) from public.week_plans',
    'select count(*) from public.checked_items', 'select count(*) from public.manual_items',
    'select count(*) from public.imports'
  ];

  -- 2. Позитивные контролы: что разрешено.
  p_names text[] := array[
    'anon: SELECT recipes (positive)', 'auth A: SELECT own profiles (positive)',
    'auth A: SELECT own checked_items (positive)'
  ];
  p_queries text[] := array[
    'select count(*) from public.recipes',
    format('select count(*) from public.profiles where user_id = %L', ua),
    format('select count(*) from public.checked_items where user_id = %L', ua)
  ];
  p_expect int[] := array[18, 1, 1];

  -- 3. Пользователь A не видит строки пользователя B: ожидаем 0.
  b_names text[] := array[
    'auth A: SELECT B profiles', 'auth A: SELECT B week_plans',
    'auth A: SELECT B checked_items', 'auth A: SELECT B manual_items',
    'auth A: SELECT B imports'
  ];
  b_queries text[] := array[
    format('select count(*) from public.profiles where user_id = %L', ub),
    format('select count(*) from public.week_plans where user_id = %L', ub),
    format('select count(*) from public.checked_items where user_id = %L', ub),
    format('select count(*) from public.manual_items where user_id = %L', ub),
    format('select count(*) from public.imports where user_id = %L', ub)
  ];

  -- 4. Пользователь A не меняет и не удаляет строки B: ожидаем 0 затронутых строк.
  z_names text[] := array[
    'auth A: UPDATE B profiles', 'auth A: DELETE B manual_items',
    'auth A: UPDATE B week_plans', 'auth A: DELETE B checked_items'
  ];
  z_queries text[] := array[
    format('update public.profiles set people = 6 where user_id = %L', ub),
    format('delete from public.manual_items where user_id = %L', ub),
    format('update public.week_plans set days = days where user_id = %L', ub),
    format('delete from public.checked_items where user_id = %L', ub)
  ];

  -- 5. Запрещённые записи и TRUNCATE: ожидаем ошибку.
  d_names text[] := array[
    'anon: INSERT recipes', 'anon: UPDATE recipes', 'anon: TRUNCATE profiles',
    'auth A: INSERT B profile', 'auth A: INSERT B import', 'auth A: INSERT recipes',
    'auth A: UPDATE own import', 'auth A: DELETE own import', 'auth A: TRUNCATE profiles'
  ];
  d_roles text[] := array[
    'anon', 'anon', 'anon',
    'authenticated', 'authenticated', 'authenticated',
    'authenticated', 'authenticated', 'authenticated'
  ];
  d_queries text[] := array[
    'insert into public.recipes (id,title,time,servings,intro,image) values (''probe'',''x'',1,1,''x'',''x'')',
    'update public.recipes set title = ''x'' where id = ''pasta''',
    'truncate public.profiles',
    format('insert into public.profiles (user_id) values (%L)', ub),
    format('insert into public.imports (user_id) values (%L)', ub),
    'insert into public.recipes (id,title,time,servings,intro,image) values (''probe'',''x'',1,1,''x'',''x'')',
    format('update public.imports set source = ''x'' where user_id = %L', ua),
    format('delete from public.imports where user_id = %L', ua),
    'truncate public.profiles'
  ];
begin
  -- Временная таблица результатов доступна тестовым ролям только внутри этой транзакции.
  execute format('grant usage on schema %I to anon, authenticated', v_temp);
  execute format('grant insert on %I.tarelka_rls_probe to anon, authenticated', v_temp);

  -- Вымышленные пользователи и по строке в каждой пользовательской таблице.
  insert into auth.users (id, aud, role, email) values
    (ua, 'authenticated', 'authenticated', 'rls-probe-a@example.test'),
    (ub, 'authenticated', 'authenticated', 'rls-probe-b@example.test');
  insert into public.profiles (user_id, onboarded, diet, people) values (ua, true, 'none', 2), (ub, true, 'none', 4);
  insert into public.week_plans (user_id) values (ua), (ub);
  insert into public.checked_items (user_id, key) values (ua, 'plan|veg|Томаты|шт'), (ub, 'plan|veg|Огурцы|шт');
  insert into public.manual_items (user_id, id, name) values (ua, 'probe-a', 'Проба A'), (ub, 'probe-b', 'Проба B');
  insert into public.imports (user_id) values (ua), (ub);

  -- a) anon не читает пользовательские таблицы: ожидаем ошибку.
  for i in 1..array_length(u_names, 1) loop
    begin
      execute 'reset role';
      perform set_config('request.jwt.claim.sub', '', true);
      execute 'set local role anon';
      perform set_config('search_path', v_temp || ', public', true);
      execute u_queries[i] into n;
      insert into tarelka_rls_probe values (u_names[i], false, 'доступ разрешён, строк=' || n);
    exception when others then
      insert into tarelka_rls_probe values (u_names[i], true, sqlerrm);
    end;
  end loop;

  -- b) Позитивные контролы: что разрешено.
  for i in 1..array_length(p_names, 1) loop
    begin
      execute 'reset role';
      perform set_config('request.jwt.claim.sub', case when p_names[i] like 'anon%' then '' else ua::text end, true);
      execute format('set local role %I', case when p_names[i] like 'anon%' then 'anon' else 'authenticated' end);
      perform set_config('search_path', v_temp || ', public', true);
      execute p_queries[i] into n;
      if n = p_expect[i] then
        insert into tarelka_rls_probe values (p_names[i], true, 'строк=' || n);
      else
        insert into tarelka_rls_probe values (p_names[i], false, 'ожидалось ' || p_expect[i] || ', получено ' || n);
      end if;
    exception when others then
      insert into tarelka_rls_probe values (p_names[i], false, sqlerrm);
    end;
  end loop;

  -- c) Пользователь A не видит строки пользователя B: ожидаем 0.
  for i in 1..array_length(b_names, 1) loop
    begin
      execute 'reset role';
      perform set_config('request.jwt.claim.sub', ua::text, true);
      execute 'set local role authenticated';
      perform set_config('search_path', v_temp || ', public', true);
      execute b_queries[i] into n;
      if n = 0 then
        insert into tarelka_rls_probe values (b_names[i], true, 'строк B: 0');
      else
        insert into tarelka_rls_probe values (b_names[i], false, 'видно строк B: ' || n);
      end if;
    exception when others then
      insert into tarelka_rls_probe values (b_names[i], false, sqlerrm);
    end;
  end loop;

  -- d) Пользователь A не меняет и не удаляет строки B: ожидаем 0 затронутых строк.
  for i in 1..array_length(z_names, 1) loop
    begin
      execute 'reset role';
      perform set_config('request.jwt.claim.sub', ua::text, true);
      execute 'set local role authenticated';
      perform set_config('search_path', v_temp || ', public', true);
      execute z_queries[i];
      get diagnostics n = row_count;
      if n = 0 then
        insert into tarelka_rls_probe values (z_names[i], true, 'затронуто строк: 0');
      else
        insert into tarelka_rls_probe values (z_names[i], false, 'затронуто строк: ' || n);
      end if;
    exception when others then
      insert into tarelka_rls_probe values (z_names[i], false, sqlerrm);
    end;
  end loop;

  -- e) Запрещённые записи и TRUNCATE: ожидаем ошибку.
  for i in 1..array_length(d_names, 1) loop
    begin
      execute 'reset role';
      perform set_config('request.jwt.claim.sub', case when d_roles[i] = 'anon' then '' else ua::text end, true);
      execute format('set local role %I', d_roles[i]);
      perform set_config('search_path', v_temp || ', public', true);
      execute d_queries[i];
      get diagnostics n = row_count;
      insert into tarelka_rls_probe values (d_names[i], false, 'разрешено, затронуто строк=' || n);
    exception when others then
      insert into tarelka_rls_probe values (d_names[i], true, sqlerrm);
    end;
  end loop;

  execute 'reset role';
end $$;

-- Результаты прогона: все passed должны быть true.
select test, passed, detail from tarelka_rls_probe order by test;

-- Откат: вымышленные пользователи, строки и временные права не сохраняются.
rollback;

-- Контроль после отката: пробных данных нет, каталог на месте.
select
  (select count(*) from auth.users where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')) as probe_users,
  (select count(*) from public.profiles) as profiles_total,
  (select count(*) from public.week_plans) as plans_total,
  (select count(*) from public.checked_items) as checked_total,
  (select count(*) from public.manual_items) as manual_total,
  (select count(*) from public.imports) as imports_total,
  (select count(*) from public.recipes) as recipes_total,
  (select count(*) from public.recipes where id = 'probe') as probe_recipes;
