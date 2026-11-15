-- 04: Optional scheduler. Apply after 03. No external HTTP calls or secrets.
-- If pg_cron cannot be enabled here, enable Cron in the Supabase Dashboard,
-- then rerun this file. Session creation/access still performs atomic cleanup.
begin;
create extension if not exists pg_cron;
select cron.schedule('relay-expire-sessions', '* * * * *', 'select relay_private.expire_sessions()');
commit;
