-- Tarelka: расширение pgTAP для серверных тестов API.
-- Устанавливается в служебную схему extensions, не в public.
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
