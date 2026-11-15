-- Relay Step 2: schema and integrity rules only. No participant workflows.
-- Apply through the Supabase CLI migration workflow, never a public HTTP route.
begin;

create schema relay_private;
revoke all on schema relay_private from public, anon, authenticated;
grant usage on schema relay_private to service_role;

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null unique check (
    char_length(session_code) between 1 and 128 and session_code = btrim(session_code)
  ),
  status text not null default 'waiting' check (status in ('waiting', 'active', 'terminated')),
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  activated_at timestamptz,
  terminated_at timestamptz,
  both_disconnected_at timestamptz,
  inactivity_deadline_at timestamptz,
  constraint sessions_termination_timestamp check (
    (status = 'terminated') = (terminated_at is not null)
  ),
  constraint sessions_inactivity_window check (
    (both_disconnected_at is null and inactivity_deadline_at is null)
    or (both_disconnected_at is not null and inactivity_deadline_at is not null
      and inactivity_deadline_at = both_disconnected_at + interval '10 minutes')
  ),
  constraint sessions_timestamp_order check (
    last_activity_at >= created_at
    and (activated_at is null or activated_at >= created_at)
    and (terminated_at is null or terminated_at >= created_at)
  )
);

-- All non-terminated rows compete for the same unique index key.
-- PostgreSQL enforces this across transactions, not only in a single process.
create unique index sessions_one_non_terminated
  on public.sessions ((true)) where status <> 'terminated';

create table public.session_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  role text not null check (role in ('sender', 'viewer')),
  connection_status text not null default 'disconnected'
    check (connection_status in ('connected', 'disconnected')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  explicitly_quit boolean not null default false,
  quit_at timestamptz,
  -- Future high-entropy reconnect credentials are hashed on the server before insertion.
  -- This column accepts a SHA-256/HMAC-SHA-256 digest, never the bearer credential.
  reconnect_token_hash text not null unique check (reconnect_token_hash ~ '^[0-9a-f]{64}$'),
  token_issued_at timestamptz not null default now(),
  token_expires_at timestamptz,
  token_revoked_at timestamptz,
  connection_epoch bigint not null default 0 check (connection_epoch >= 0),
  constraint session_participants_one_role unique (session_id, role),
  constraint session_participants_quit_state check (
    explicitly_quit = (quit_at is not null)
    and (not explicitly_quit or connection_status = 'disconnected')
  ),
  constraint session_participants_token_expiry check (
    token_expires_at is null or token_expires_at > token_issued_at
  )
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  question_text text not null check (btrim(question_text) <> ''),
  submitted_at timestamptz not null default now(),
  processing_status text not null default 'queued'
    check (processing_status in ('queued', 'processing', 'completed', 'superseded', 'failed')),
  sequence_number bigint generated always as identity unique,
  processing_started_at timestamptz,
  processing_finished_at timestamptz,
  constraint questions_session_and_id unique (session_id, id)
);
create index questions_session_order on public.questions (session_id, sequence_number desc);

create table public.session_answer_state (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  latest_question_id uuid,
  answer_text text,
  readiness_status text not null default 'empty' check (readiness_status in ('empty', 'pending', 'ready')),
  updated_at timestamptz not null default now(),
  constraint session_answer_state_same_session_question
    foreign key (session_id, latest_question_id)
    references public.questions(session_id, id) on delete cascade,
  constraint session_answer_state_readiness check (
    (readiness_status = 'empty' and latest_question_id is null and answer_text is null)
    or (readiness_status = 'pending' and latest_question_id is not null and answer_text is null)
    or (readiness_status = 'ready' and latest_question_id is not null
      and answer_text is not null and btrim(answer_text) <> '')
  )
);

create table public.prepared_qa (
  id uuid primary key default gen_random_uuid(),
  question text not null check (btrim(question) <> ''),
  answer text not null check (btrim(answer) <> ''),
  alternative_questions text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Supports exact equality without a B-tree text-length limit or text normalization.
create index prepared_qa_exact_question on public.prepared_qa using hash (question) where is_active;

create table public.reference_documents (
  id uuid primary key default gen_random_uuid(),
  original_filename text not null check (btrim(original_filename) <> ''),
  storage_bucket text not null default 'reference-documents' check (storage_bucket = 'reference-documents'),
  storage_path text not null check (btrim(storage_path) <> ''),
  file_type text not null check (btrim(file_type) <> ''),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  processing_status text not null default 'pending' check (processing_status in ('pending', 'processing', 'ready', 'failed')),
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  constraint reference_documents_storage_location unique (storage_bucket, storage_path)
);

create table public.reference_document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.reference_documents(id) on delete cascade,
  content text not null check (btrim(content) <> ''),
  chunk_index integer not null check (chunk_index >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reference_document_chunks_order unique (document_id, chunk_index)
);

comment on table public.session_answer_state is
  'Transient latest-answer delivery/reconnection state. Deleted on session termination. Never prepared knowledge.';
comment on column public.prepared_qa.answer is
  'Exact source answer: never normalized, trimmed, or rewritten by storage triggers.';
comment on column public.questions.sequence_number is
  'Global monotonic allocation order; gaps are valid. Future submissions must lock their session before allocation to serialize acceptance order.';
comment on column public.session_participants.reconnect_token_hash is
  'Only a digest of a future high-entropy credential. Token creation, comparison, expiry, and rotation are future server workflows.';
comment on table public.reference_document_chunks is
  'Extracted text foundation only. Add model-specific embedding storage in a future migration after model selection.';

create function relay_private.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create function relay_private.require_live_answer_session()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  current_status text;
begin
  -- Serialize answer insertion against session termination. Future writers should
  -- lock the session first, then write answer state, to maintain one lock order.
  select status into current_status from public.sessions
    where id = new.session_id for update;
  if not found or current_status = 'terminated' then
    raise exception 'Answer state requires a non-terminated session' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function relay_private.clear_terminated_answer_state()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.session_answer_state where session_id = new.id;
  return new;
end;
$$;

create trigger sessions_clear_answer_after_termination
  after update of status on public.sessions
  for each row when (new.status = 'terminated' and old.status <> 'terminated')
  execute function relay_private.clear_terminated_answer_state();
create trigger session_answer_state_require_live_session
  before insert or update on public.session_answer_state
  for each row execute function relay_private.require_live_answer_session();
create trigger session_answer_state_touch_updated_at
  before update on public.session_answer_state
  for each row execute function relay_private.touch_updated_at();
create trigger prepared_qa_touch_updated_at
  before update on public.prepared_qa
  for each row execute function relay_private.touch_updated_at();
create trigger reference_documents_touch_updated_at
  before update on public.reference_documents
  for each row execute function relay_private.touch_updated_at();
create trigger reference_document_chunks_touch_updated_at
  before update on public.reference_document_chunks
  for each row execute function relay_private.touch_updated_at();

-- Deny access even on projects with permissive default public-schema grants.
-- No application table has an anon/authenticated policy in Step 2.
alter table public.sessions enable row level security;
alter table public.sessions force row level security;
alter table public.session_participants enable row level security;
alter table public.session_participants force row level security;
alter table public.questions enable row level security;
alter table public.questions force row level security;
alter table public.session_answer_state enable row level security;
alter table public.session_answer_state force row level security;
alter table public.prepared_qa enable row level security;
alter table public.prepared_qa force row level security;
alter table public.reference_documents enable row level security;
alter table public.reference_documents force row level security;
alter table public.reference_document_chunks enable row level security;
alter table public.reference_document_chunks force row level security;

revoke all on table
  public.sessions, public.session_participants, public.questions,
  public.session_answer_state, public.prepared_qa,
  public.reference_documents, public.reference_document_chunks
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table
  public.sessions, public.session_participants, public.questions,
  public.session_answer_state, public.prepared_qa,
  public.reference_documents, public.reference_document_chunks
  to service_role;

revoke all on sequence public.questions_sequence_number_seq from public, anon, authenticated, service_role;
grant usage on sequence public.questions_sequence_number_seq to service_role;
revoke all on all functions in schema relay_private from public, anon, authenticated;
grant execute on all functions in schema relay_private to service_role;

-- Deliberately no realtime publication, public RPCs, vector extension/dimension,
-- auth integration, schedules, uploads, seeds, or session creation function.
commit;
