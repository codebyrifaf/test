-- Read-only metadata verification. Run in the Supabase Dashboard SQL Editor.
-- Returns no participant credentials, session codes, answers, or document text.
select jsonb_build_object(
  'service_rpcs', (select jsonb_agg(jsonb_build_object(
    'name', p.proname,
    'service_can_execute', has_function_privilege('service_role', p.oid, 'execute'),
    'anon_can_execute', has_function_privilege('anon', p.oid, 'execute'),
    'authenticated_can_execute', has_function_privilege('authenticated', p.oid, 'execute')
  ) order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'relay_%'),
  'embedding_columns', (select jsonb_agg(jsonb_build_object('table', c.relname, 'type', format_type(a.atttypid, a.atttypmod)))
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('prepared_qa', 'reference_document_chunks') and a.attname = 'embedding'),
  'expiration_schedule', (select jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active,
    'expected_command', command = 'select relay_private.expire_sessions()')) from cron.job where jobname = 'relay-expire-sessions'),
  'recent_expiration_runs', (select jsonb_agg(jsonb_build_object('status', status, 'started_at', start_time, 'finished_at', end_time))
    from (select status, start_time, end_time from cron.job_run_details where jobid in
      (select jobid from cron.job where jobname = 'relay-expire-sessions') order by start_time desc limit 3) recent)
) as relay_application_verification;
