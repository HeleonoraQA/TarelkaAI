-- Tarelka: ужесточение доступа к public.imports.
-- Клиент может только прочитать и создать отметку импорта своей строки.
-- UPDATE и DELETE не нужны: импорт должен оставаться одноразовым.

drop policy if exists own_rows on public.imports;

create policy imports_select_own on public.imports
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy imports_insert_own on public.imports
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

revoke update, delete on public.imports from authenticated;
