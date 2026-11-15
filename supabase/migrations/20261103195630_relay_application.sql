-- 03: Relay application operations. Apply AFTER the two Step 2 migrations.
-- Additive: no existing tables or knowledge are deleted. No public RPC access.
begin;

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

alter table public.sessions add column if not exists latest_question_id uuid;
alter table public.questions add column if not exists client_request_id uuid;
alter table public.questions add column if not exists lease_id uuid;
alter table public.questions add column if not exists lease_until timestamptz;
alter table public.questions add column if not exists attempts integer not null default 0;
alter table public.questions add column if not exists error_code text;
alter table public.questions add column if not exists delivered_at timestamptz;
create unique index if not exists questions_request_idempotency
  on public.questions(session_id, client_request_id) where client_request_id is not null;

create table if not exists public.relay_rate_limits (
  scope text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);
alter table public.relay_rate_limits enable row level security;
alter table public.relay_rate_limits force row level security;
revoke all on public.relay_rate_limits from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.relay_rate_limits to service_role;

create or replace function relay_private.reconcile_session(p_session_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare s public.sessions; disconnected_at timestamptz; connected_count integer; quit_count integer;
begin
  select * into s from public.sessions where id = p_session_id for update;
  if not found or s.status = 'terminated' then return true; end if;
  update public.session_participants set connection_status = 'disconnected',
    last_disconnected_at = last_seen_at + interval '45 seconds'
    where session_id = s.id and connection_status = 'connected'
      and last_seen_at < now() - interval '45 seconds';
  select count(*) filter (where connection_status = 'connected' and not explicitly_quit),
    count(*) filter (where explicitly_quit)
    into connected_count, quit_count from public.session_participants where session_id = s.id;
  if quit_count = 2 then
    update public.sessions set status = 'terminated', terminated_at = now() where id = s.id;
    return true;
  end if;
  if connected_count > 0 then
    update public.sessions set both_disconnected_at = null, inactivity_deadline_at = null where id = s.id;
    return false;
  end if;
  select coalesce(max(coalesce(last_disconnected_at, quit_at, last_seen_at + interval '45 seconds')), s.created_at)
    into disconnected_at from public.session_participants where session_id = s.id;
  disconnected_at := coalesce(s.both_disconnected_at, disconnected_at);
  if now() >= disconnected_at + interval '10 minutes' then
    update public.sessions set status = 'terminated', terminated_at = now(),
      both_disconnected_at = disconnected_at, inactivity_deadline_at = disconnected_at + interval '10 minutes'
      where id = s.id;
    return true;
  end if;
  update public.sessions set both_disconnected_at = disconnected_at,
    inactivity_deadline_at = disconnected_at + interval '10 minutes' where id = s.id;
  return false;
end;
$$;

create or replace function relay_private.expire_sessions()
returns integer language plpgsql security invoker set search_path = '' as $$
declare item record; expired integer := 0;
begin
  for item in select id from public.sessions where status <> 'terminated' loop
    if relay_private.reconcile_session(item.id) then expired := expired + 1; end if;
  end loop;
  delete from public.relay_rate_limits where window_started_at < now() - interval '2 days';
  return expired;
end;
$$;

create or replace function relay_private.require_participant(p_token_hash text, p_role text)
returns public.session_participants language plpgsql security invoker set search_path = '' as $$
declare participant public.session_participants;
begin
  select * into participant from public.session_participants where reconnect_token_hash = p_token_hash
    and role = p_role and token_revoked_at is null and not explicitly_quit
    and (token_expires_at is null or token_expires_at > now());
  if not found then raise exception 'RELAY_UNAUTHORIZED'; end if;
  if relay_private.reconcile_session(participant.session_id) then raise exception 'RELAY_SESSION_ENDED'; end if;
  -- Recheck after taking the session lock: a concurrent quit may have revoked it.
  select * into participant from public.session_participants where reconnect_token_hash = p_token_hash
    and role = p_role and token_revoked_at is null and not explicitly_quit;
  if not found then raise exception 'RELAY_UNAUTHORIZED'; end if;
  return participant;
end;
$$;

create or replace function public.relay_rate_limit(p_scope text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare total integer; started timestamptz;
begin
  if p_limit < 1 or p_window_seconds < 1 or char_length(p_scope) > 200 then raise exception 'RELAY_INVALID_INPUT'; end if;
  started := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.relay_rate_limits(scope, window_started_at, request_count) values (p_scope, started, 1)
  on conflict (scope) do update set window_started_at = excluded.window_started_at,
    request_count = case when public.relay_rate_limits.window_started_at = excluded.window_started_at
      then public.relay_rate_limits.request_count + 1 else 1 end
  returning request_count into total;
  return total <= p_limit;
end;
$$;

create or replace function public.relay_session_availability()
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  perform relay_private.expire_sessions();
  return jsonb_build_object('available', not exists(select 1 from public.sessions where status <> 'terminated'));
end;
$$;

create or replace function public.relay_create_session(p_code text, p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare session_id uuid;
begin
  perform pg_advisory_xact_lock(17683294);
  perform relay_private.expire_sessions();
  if exists(select 1 from public.sessions where status <> 'terminated') then raise exception 'RELAY_SESSION_BUSY'; end if;
  if char_length(p_code) < 16 or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'RELAY_INVALID_INPUT'; end if;
  insert into public.sessions(session_code) values(p_code) returning id into session_id;
  insert into public.session_participants(session_id, role, reconnect_token_hash, connection_status, last_connected_at)
    values(session_id, 'sender', p_token_hash, 'connected', now());
  return jsonb_build_object('sessionId', session_id, 'sessionCode', p_code, 'role', 'sender');
end;
$$;

create or replace function public.relay_join_session(p_code text, p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.sessions;
begin
  select * into s from public.sessions where session_code = p_code and status <> 'terminated' for update;
  if not found then raise exception 'RELAY_INVALID_CODE'; end if;
  if relay_private.reconcile_session(s.id) then raise exception 'RELAY_SESSION_ENDED'; end if;
  if exists(select 1 from public.session_participants where session_id = s.id and role = 'viewer') then
    raise exception 'RELAY_VIEWER_TAKEN';
  end if;
  insert into public.session_participants(session_id, role, reconnect_token_hash, connection_status, last_connected_at)
    values(s.id, 'viewer', p_token_hash, 'connected', now());
  update public.sessions set status = 'active', activated_at = coalesce(activated_at, now()),
    last_activity_at = now(), both_disconnected_at = null, inactivity_deadline_at = null where id = s.id;
  return jsonb_build_object('sessionId', s.id, 'role', 'viewer');
end;
$$;

create or replace function public.relay_session_snapshot(p_token_hash text, p_role text, p_heartbeat boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare participant public.session_participants; s public.sessions; q public.questions; result jsonb; answer_state public.session_answer_state;
begin
  participant := relay_private.require_participant(p_token_hash, p_role);
  if p_heartbeat then
    update public.session_participants set last_seen_at = now(), connection_status = 'connected',
      last_connected_at = case when connection_status <> 'connected' then now() else last_connected_at end,
      connection_epoch = connection_epoch + case when connection_status <> 'connected' then 1 else 0 end
      where id = participant.id;
    update public.sessions set last_activity_at = now(), both_disconnected_at = null, inactivity_deadline_at = null
      where id = participant.session_id;
  end if;
  select * into s from public.sessions where id = participant.session_id;
  result := jsonb_build_object('sessionId', s.id, 'role', p_role, 'status', s.status,
    'senderConnected', exists(select 1 from public.session_participants where session_id = s.id and role = 'sender' and connection_status = 'connected' and not explicitly_quit),
    'viewerConnected', exists(select 1 from public.session_participants where session_id = s.id and role = 'viewer' and connection_status = 'connected' and not explicitly_quit));
  if p_role = 'sender' then
    select * into q from public.questions where id = s.latest_question_id;
    -- Deliberately never select answer_state or prepared answers for this branch.
    result := result || jsonb_build_object('sessionCode', s.session_code,
      'question', case when q.id is null then null else jsonb_build_object('id', q.id, 'sequence', q.sequence_number,
        'status', q.processing_status, 'errorCode', q.error_code, 'delivered', q.delivered_at is not null) end);
  else
    select * into answer_state from public.session_answer_state where session_id = s.id and readiness_status = 'ready';
    result := result || jsonb_build_object('answer', case when answer_state.latest_question_id is null then null else
      jsonb_build_object('id', answer_state.latest_question_id, 'text', answer_state.answer_text, 'updatedAt', answer_state.updated_at) end);
  end if;
  return result;
end;
$$;

create or replace function public.relay_quit_session(p_token_hash text, p_role text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare participant public.session_participants; ended boolean;
begin
  participant := relay_private.require_participant(p_token_hash, p_role);
  update public.session_participants set explicitly_quit = true, quit_at = now(), token_revoked_at = now(),
    connection_status = 'disconnected', last_disconnected_at = now() where id = participant.id;
  ended := relay_private.reconcile_session(participant.session_id);
  return jsonb_build_object('quit', true, 'terminated', ended);
end;
$$;

create or replace function public.relay_submit_question(p_token_hash text, p_text text, p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare participant public.session_participants; q public.questions;
begin
  participant := relay_private.require_participant(p_token_hash, 'sender');
  if char_length(btrim(p_text)) = 0 or char_length(p_text) > 12000 or p_request_id is null then raise exception 'RELAY_INVALID_INPUT'; end if;
  select * into q from public.questions where session_id = participant.session_id and client_request_id = p_request_id;
  if found then return jsonb_build_object('id', q.id, 'sequence', q.sequence_number, 'status', q.processing_status); end if;
  -- require_participant locks the session BEFORE identity allocation.
  update public.questions set processing_status = 'superseded', processing_finished_at = now(), lease_until = null
    where session_id = participant.session_id and processing_status in ('queued', 'processing');
  insert into public.questions(session_id, question_text, client_request_id)
    values(participant.session_id, p_text, p_request_id) returning * into q;
  update public.sessions set latest_question_id = q.id, last_activity_at = now() where id = participant.session_id;
  update public.session_participants set last_seen_at = now(), connection_status = 'connected' where id = participant.id;
  return jsonb_build_object('id', q.id, 'sequence', q.sequence_number, 'status', q.processing_status);
end;
$$;

create or replace function public.relay_claim_question(p_session_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.sessions; q public.questions; lease uuid;
begin
  if relay_private.reconcile_session(p_session_id) then return null; end if;
  select * into s from public.sessions where id = p_session_id;
  select * into q from public.questions where id = s.latest_question_id for update;
  if not found or q.processing_status not in ('queued', 'processing') then return null; end if;
  if q.processing_status = 'processing' and q.lease_until > now() then return null; end if;
  if q.attempts >= 3 then
    update public.questions set processing_status = 'failed', error_code = 'PROCESSING_INTERRUPTED', processing_finished_at = now() where id = q.id;
    return null;
  end if;
  lease := gen_random_uuid();
  update public.questions set processing_status = 'processing', lease_id = lease, lease_until = now() + interval '120 seconds',
    processing_started_at = now(), attempts = attempts + 1, error_code = null where id = q.id;
  return jsonb_build_object('id', q.id, 'sessionId', s.id, 'text', q.question_text, 'sequence', q.sequence_number, 'leaseId', lease);
end;
$$;

create or replace function public.relay_finish_question(p_question_id uuid, p_lease_id uuid, p_answer text, p_error_code text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare target_session_id uuid; s public.sessions; q public.questions;
begin
  select questions.session_id into target_session_id from public.questions where id = p_question_id;
  if target_session_id is null or relay_private.reconcile_session(target_session_id) then return false; end if;
  select * into s from public.sessions where id = target_session_id;
  select * into q from public.questions where id = p_question_id for update;
  if s.latest_question_id <> q.id or q.processing_status <> 'processing' or q.lease_id is distinct from p_lease_id
    or q.lease_until <= now() then return false; end if;
  if p_error_code is not null then
    update public.questions set processing_status = 'failed', error_code = left(p_error_code, 64), processing_finished_at = now(), lease_until = null where id = q.id;
    return true; -- The previous valid answer is deliberately untouched.
  end if;
  if p_answer is null or btrim(p_answer) = '' then raise exception 'RELAY_INVALID_ANSWER'; end if;
  insert into public.session_answer_state(session_id, latest_question_id, answer_text, readiness_status)
    values(s.id, q.id, p_answer, 'ready') on conflict (session_id) do update set
      latest_question_id = excluded.latest_question_id, answer_text = excluded.answer_text, readiness_status = 'ready';
  update public.questions set processing_status = 'completed', error_code = null, processing_finished_at = now(), lease_until = null where id = q.id;
  return true;
end;
$$;

create or replace function public.relay_ack_answer(p_token_hash text, p_question_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare participant public.session_participants;
begin
  participant := relay_private.require_participant(p_token_hash, 'viewer');
  update public.questions set delivered_at = coalesce(delivered_at, now()) where id = p_question_id
    and session_id = participant.session_id and processing_status = 'completed';
  return found;
end;
$$;

-- Exact aliases and semantic/keyword retrieval are permanent prepared knowledge.
create or replace function relay_private.normalize_question(p_text text)
returns text language sql immutable strict set search_path = '' as $$
  select lower(btrim(regexp_replace(p_text, '\s+', ' ', 'g')));
$$;

create table if not exists public.prepared_question_variants (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.prepared_qa(id) on delete cascade,
  normalized_text text not null,
  fingerprint text generated always as (md5(normalized_text)) stored unique
);
alter table public.prepared_question_variants enable row level security;
alter table public.prepared_question_variants force row level security;
revoke all on public.prepared_question_variants from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.prepared_question_variants to service_role;
create index if not exists prepared_question_variants_entry on public.prepared_question_variants(entry_id);

alter table public.prepared_qa add column if not exists search_vector tsvector;
alter table public.prepared_qa add column if not exists embedding extensions.vector(768);
alter table public.prepared_qa add column if not exists embedding_model text;
alter table public.prepared_qa add column if not exists embedding_hash text;
alter table public.reference_document_chunks add column if not exists search_vector tsvector;
alter table public.reference_document_chunks add column if not exists embedding extensions.vector(768);
alter table public.reference_document_chunks add column if not exists embedding_model text;
alter table public.reference_document_chunks add column if not exists embedding_hash text;
alter table public.reference_documents add column if not exists error_code text;

create or replace function relay_private.prepare_knowledge_search()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.search_vector := to_tsvector('simple', new.question || ' ' || array_to_string(new.alternative_questions, ' '));
  if tg_op = 'UPDATE' and (new.question is distinct from old.question or new.alternative_questions is distinct from old.alternative_questions) then
    new.embedding := null; new.embedding_model := null; new.embedding_hash := null;
  end if;
  return new;
end;
$$;
create or replace function relay_private.refresh_question_variants()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.prepared_question_variants where entry_id = new.id;
  insert into public.prepared_question_variants(entry_id, normalized_text)
    select new.id, normalized from (
      select distinct relay_private.normalize_question(value) as normalized
      from unnest(array_prepend(new.question, new.alternative_questions)) as value
    ) variants where normalized <> '';
  return new;
end;
$$;
create or replace function relay_private.prepare_chunk_search()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.search_vector := to_tsvector('simple', new.content);
  if tg_op = 'UPDATE' and new.content is distinct from old.content then
    new.embedding := null; new.embedding_model := null; new.embedding_hash := null;
  end if;
  return new;
end;
$$;

drop trigger if exists prepared_qa_prepare_search on public.prepared_qa;
create trigger prepared_qa_prepare_search before insert or update of question, alternative_questions on public.prepared_qa
  for each row execute function relay_private.prepare_knowledge_search();
drop trigger if exists prepared_qa_refresh_variants on public.prepared_qa;
create trigger prepared_qa_refresh_variants after insert or update of question, alternative_questions on public.prepared_qa
  for each row execute function relay_private.refresh_question_variants();
drop trigger if exists reference_chunks_prepare_search on public.reference_document_chunks;
create trigger reference_chunks_prepare_search before insert or update of content on public.reference_document_chunks
  for each row execute function relay_private.prepare_chunk_search();

-- Backfill existing prepared data; duplicate normalized questions fail safely.
update public.prepared_qa set question = question;
update public.reference_document_chunks set content = content;
create index if not exists prepared_qa_search on public.prepared_qa using gin(search_vector);
create index if not exists reference_chunks_search on public.reference_document_chunks using gin(search_vector);
create index if not exists prepared_qa_embedding on public.prepared_qa using hnsw(embedding extensions.vector_cosine_ops) where embedding is not null;
create index if not exists reference_chunks_embedding on public.reference_document_chunks using hnsw(embedding extensions.vector_cosine_ops) where embedding is not null;

create or replace function public.relay_exact_answer(p_question text)
returns table(id uuid, answer text) language sql stable security invoker set search_path = '' as $$
  select q.id, q.answer from public.prepared_qa q join public.prepared_question_variants v on v.entry_id = q.id
  where q.is_active and v.fingerprint = md5(relay_private.normalize_question(p_question))
    and v.normalized_text = relay_private.normalize_question(p_question) limit 1;
$$;

create or replace function public.relay_search_prepared(p_question text, p_embedding extensions.vector default null, p_model text default null)
returns table(id uuid, question text, alternative_questions text[], score double precision)
language sql stable security invoker set search_path = '' as $$
  select q.id, q.question, q.alternative_questions,
    greatest(case when p_embedding is not null and q.embedding_model = p_model then 1 - (q.embedding operator(extensions.<=>) p_embedding) else 0 end,
      case when q.search_vector @@ websearch_to_tsquery('simple', p_question) then 0.5 + least(ts_rank(q.search_vector, websearch_to_tsquery('simple', p_question)), 0.4) else 0 end)::double precision as score
  from public.prepared_qa q where q.is_active and (
    q.search_vector @@ websearch_to_tsquery('simple', p_question)
    or (p_embedding is not null and q.embedding is not null and q.embedding_model = p_model))
  order by score desc, q.id limit 8;
$$;

create or replace function public.relay_search_chunks(p_question text, p_embedding extensions.vector default null, p_model text default null)
returns table(id uuid, document_id uuid, content text, filename text, score double precision)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.document_id, c.content, d.original_filename,
    greatest(case when p_embedding is not null and c.embedding_model = p_model then 1 - (c.embedding operator(extensions.<=>) p_embedding) else 0 end,
      case when c.search_vector @@ websearch_to_tsquery('simple', p_question) then 0.5 + least(ts_rank(c.search_vector, websearch_to_tsquery('simple', p_question)), 0.4) else 0 end)::double precision as score
  from public.reference_document_chunks c join public.reference_documents d on d.id = c.document_id
  where d.processing_status = 'ready' and (c.search_vector @@ websearch_to_tsquery('simple', p_question)
    or (p_embedding is not null and c.embedding is not null and c.embedding_model = p_model))
  order by score desc, c.id limit 12;
$$;

-- Explicit RPC allowlist: only the server credential can execute these operations.
do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'relay_rate_limit', 'relay_session_availability', 'relay_create_session', 'relay_join_session',
      'relay_session_snapshot', 'relay_quit_session', 'relay_submit_question', 'relay_claim_question',
      'relay_finish_question', 'relay_ack_answer', 'relay_exact_answer', 'relay_search_prepared', 'relay_search_chunks'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;
end;
$$;
revoke all on all functions in schema relay_private from public, anon, authenticated;
grant execute on all functions in schema relay_private to service_role;
grant usage on schema extensions to service_role;
notify pgrst, 'reload schema';
commit;
