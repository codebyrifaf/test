-- Bucket configuration is migration-managed; no files are uploaded here.
begin;

-- Fail on a pre-existing name rather than silently adopting or changing its data.
insert into storage.buckets (id, name, public)
values ('reference-documents', 'reference-documents', false);

-- These restrictive policies also protect this bucket when a project already
-- has unrelated permissive storage policies. Other buckets are unaffected.
-- They grant nothing: Supabase's default-deny RLS remains in effect.
create policy relay_reference_objects_deny_client_access
  on storage.objects as restrictive for all to anon, authenticated
  using (bucket_id <> 'reference-documents')
  with check (bucket_id <> 'reference-documents');

create policy relay_reference_buckets_deny_client_access
  on storage.buckets as restrictive for all to anon, authenticated
  using (id <> 'reference-documents')
  with check (id <> 'reference-documents');

commit;
