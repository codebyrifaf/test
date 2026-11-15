-- Read-only metadata verification. Safe to run in the Supabase SQL Editor.
-- Does not select participant data, questions, answers, credentials, or document content.
with target(name) as (
  values ('sessions'), ('session_participants'), ('questions'),
    ('session_answer_state'), ('prepared_qa'),
    ('reference_documents'), ('reference_document_chunks')
)
select jsonb_build_object(
  'tables', (
    select jsonb_agg(jsonb_build_object(
      'name', target.name,
      'exists', c.oid is not null,
      'rls', c.relrowsecurity,
      'forced_rls', c.relforcerowsecurity,
      'anon_has_access', has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
      'authenticated_has_access', has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
      'service_can_read', has_table_privilege('service_role', c.oid, 'SELECT')
    ) order by target.name)
    from target left join pg_class c
      on c.relname = target.name and c.relnamespace = 'public'::regnamespace
  ),
  'session_uniqueness', (
    select jsonb_build_object('unique', i.indisunique, 'valid', i.indisvalid,
      'definition', pg_get_indexdef(i.indexrelid))
    from pg_index i where i.indexrelid = to_regclass('public.sessions_one_non_terminated')
  ),
  'answer_integrity_triggers', (
    select jsonb_agg(jsonb_build_object('name', t.tgname, 'enabled', t.tgenabled,
      'definition', pg_get_triggerdef(t.oid)) order by t.tgname)
    from pg_trigger t where not t.tgisinternal and t.tgname in
      ('sessions_clear_answer_after_termination', 'session_answer_state_require_live_session')
  ),
  'private_functions', (
    select jsonb_agg(jsonb_build_object('name', p.proname, 'security_definer', p.prosecdef,
      'settings', p.proconfig, 'source_md5', md5(p.prosrc),
      'anon_can_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated_can_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE')) order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'relay_private'
  ),
  'bucket', (
    select jsonb_build_object('id', id, 'private', not public)
    from storage.buckets where id = 'reference-documents'
  ),
  'storage_policies', (
    select jsonb_agg(jsonb_build_object('name', policyname, 'table', tablename,
      'permissive', permissive, 'roles', roles, 'using', qual, 'check', with_check) order by policyname)
    from pg_policies where schemaname = 'storage' and policyname in
      ('relay_reference_objects_deny_client_access', 'relay_reference_buckets_deny_client_access')
  ),
  'migration_history_table_exists', to_regclass('supabase_migrations.schema_migrations') is not null
) as foundation_verification;
