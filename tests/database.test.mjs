import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Real PostgreSQL SQL execution in memory; not a full Supabase service or a
// multi-connection race test. Managed roles/storage tables below are test fixtures.
let db;
const tables = [
  "sessions",
  "session_participants",
  "questions",
  "session_answer_state",
  "prepared_qa",
  "reference_documents",
  "reference_document_chunks",
];

before(async () => {
  db = await PGlite.create();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    create schema storage;
    create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    alter table storage.buckets enable row level security;
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on all tables in schema storage to anon, authenticated, service_role;
    -- Existing permissive policies must not expose our private bucket.
    create policy fixture_buckets_allow on storage.buckets for all to anon, authenticated using (true) with check (true);
    create policy fixture_objects_allow on storage.objects for all to anon, authenticated using (true) with check (true);
  `);
  const files = (await readdir("supabase/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .slice(0, 2);
  assert.equal(files.length, 2);
  for (const file of files)
    await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});

after(async () => {
  await db?.close();
});

test("read-only catalog verification SQL reports the deployed metadata", async () => {
  const sql = await readFile("supabase/verification/foundation.sql", "utf8");
  const {
    rows: [row],
  } = await db.query(sql);
  const report = row.foundation_verification;
  assert.equal(report.tables.length, 7);
  assert.ok(
    report.tables.every(
      (table) =>
        table.exists &&
        table.rls &&
        table.forced_rls &&
        !table.anon_has_access &&
        !table.authenticated_has_access &&
        table.service_can_read,
    ),
  );
  assert.ok(
    report.session_uniqueness.unique && report.session_uniqueness.valid,
  );
  assert.equal(report.answer_integrity_triggers.length, 2);
  assert.equal(report.private_functions.length, 3);
  assert.equal(report.bucket.private, true);
  assert.equal(report.storage_policies.length, 2);
});

async function fixture(run) {
  await db.exec("begin");
  try {
    await run();
  } finally {
    await db.exec("rollback");
  }
}

async function expectDatabaseError(sql, code, parameters = []) {
  await db.exec("savepoint expected_failure");
  try {
    await assert.rejects(db.query(sql, parameters), { code });
  } finally {
    await db.exec("rollback to savepoint expected_failure");
  }
}

async function createSession(code = "local-test-code") {
  const { rows } = await db.query(
    "insert into public.sessions (session_code) values ($1) returning id",
    [code],
  );
  return rows[0].id;
}

test("both migrations apply and all seven tables have forced RLS and no public policies", async () => {
  const { rows } = await db.query(
    "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'",
  );
  assert.deepEqual(rows.map((row) => row.relname).sort(), [...tables].sort());
  assert.ok(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  const policies = await db.query(
    "select policyname from pg_policies where schemaname = 'public'",
  );
  assert.equal(policies.rows.length, 0);
});

test("anon and authenticated cannot read/write any application table or use private helpers", async () =>
  fixture(async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of tables) {
        const {
          rows: [grants],
        } = await db.query(
          "select has_table_privilege($1, $2, 'SELECT') as read, has_table_privilege($1, $2, 'INSERT,UPDATE,DELETE,TRUNCATE') as write",
          [role, `public.${table}`],
        );
        assert.deepEqual(grants, { read: false, write: false });
        await db.exec(`set local role ${role}`);
        await expectDatabaseError(`select * from public.${table}`, "42501");
        await expectDatabaseError(
          `insert into public.${table} default values`,
          "42501",
        );
        await db.exec("reset role");
      }
      const {
        rows: [grants],
      } = await db.query(
        "select has_schema_privilege($1, 'relay_private', 'USAGE') as usage, has_function_privilege($1, 'relay_private.touch_updated_at()', 'EXECUTE') as execute",
        [role],
      );
      assert.deepEqual(grants, { usage: false, execute: false });
    }
  }));

test("RLS still denies rows if a table grant is accidentally added later", async () =>
  fixture(async () => {
    await db.exec(
      "insert into public.prepared_qa(question, answer) values ('private question', 'private answer')",
    );
    await db.exec(
      "grant select, insert on public.prepared_qa to anon; set local role anon",
    );
    assert.equal(
      (await db.query("select * from public.prepared_qa")).rows.length,
      0,
    );
    await expectDatabaseError(
      "insert into public.prepared_qa(question, answer) values ('q', 'a')",
      "42501",
    );
  }));

test("unique index blocks every second non-terminated session and releases after termination", async () =>
  fixture(async () => {
    await db.exec("set local role service_role");
    const id = await createSession();
    await expectDatabaseError(
      "insert into public.sessions(session_code) values ('second')",
      "23505",
    );
    await expectDatabaseError(
      "insert into public.sessions(session_code, status) values ('active-second', 'active')",
      "23505",
    );
    await db.query(
      "update public.sessions set status = 'terminated', terminated_at = now() where id = $1",
      [id],
    );
    await createSession("replacement");
    await expectDatabaseError(
      "update public.sessions set status = 'waiting', terminated_at = null where id = $1",
      "23505",
      [id],
    );
    assert.equal(
      (
        await db.query(
          "select * from public.sessions where status <> 'terminated'",
        )
      ).rows.length,
      1,
    );
  }));

test("role slots and hashed credentials are constrained without implementing authentication", async () =>
  fixture(async () => {
    const session = await createSession();
    const insert =
      "insert into public.session_participants(session_id, role, reconnect_token_hash) values ($1, $2, $3)";
    await db.query(insert, [session, "sender", "a".repeat(64)]);
    await db.query(insert, [session, "viewer", "b".repeat(64)]);
    await expectDatabaseError(insert, "23505", [
      session,
      "sender",
      "c".repeat(64),
    ]);
    await expectDatabaseError(insert, "23514", [
      session,
      "admin",
      "c".repeat(64),
    ]);
    await expectDatabaseError(insert, "23514", [
      session,
      "sender",
      "raw-reconnect-token",
    ]);
    await expectDatabaseError(
      "update public.session_participants set explicitly_quit = true where session_id = $1",
      "23514",
      [session],
    );
  }));

test("question allocation orders submissions and contains no generated-answer column", async () =>
  fixture(async () => {
    await db.exec("set local role service_role");
    const session = await createSession();
    const sql =
      "insert into public.questions(session_id, question_text) values ($1, $2) returning sequence_number";
    const first = (await db.query(sql, [session, "first"])).rows[0]
      .sequence_number;
    const second = (await db.query(sql, [session, "second"])).rows[0]
      .sequence_number;
    assert.ok(Number(second) > Number(first));
    const { rows } = await db.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'questions'",
    );
    assert.ok(rows.every((row) => !row.column_name.includes("answer")));
  }));

test("answer state enforces session ownership, readiness, termination cleanup, and no reinsertion", async () =>
  fixture(async () => {
    await db.exec("set local role service_role");
    const oldSession = await createSession("old-session");
    const oldQuestion = (
      await db.query(
        "insert into public.questions(session_id, question_text) values ($1, 'old') returning id",
        [oldSession],
      )
    ).rows[0].id;
    await db.query(
      "update public.sessions set status = 'terminated', terminated_at = now() where id = $1",
      [oldSession],
    );
    const session = await createSession("new-session");
    const question = (
      await db.query(
        "insert into public.questions(session_id, question_text) values ($1, 'new') returning id",
        [session],
      )
    ).rows[0].id;
    const insert =
      "insert into public.session_answer_state(session_id, latest_question_id, answer_text, readiness_status) values ($1, $2, $3, 'ready')";
    await expectDatabaseError(insert, "23503", [
      session,
      oldQuestion,
      "wrong session",
    ]);
    await expectDatabaseError(insert, "23514", [session, question, null]);
    await db.query(insert, [session, question, "transient answer"]);
    assert.equal(
      (await db.query("select * from public.session_answer_state")).rows.length,
      1,
    );
    await db.query(
      "update public.sessions set status = 'terminated', terminated_at = now() where id = $1",
      [session],
    );
    assert.equal(
      (await db.query("select * from public.session_answer_state")).rows.length,
      0,
    );
    await expectDatabaseError(insert, "23514", [
      session,
      question,
      "late completion",
    ]);
  }));

test("deleting a session cascades temporary state, participants, and questions", async () =>
  fixture(async () => {
    const session = await createSession();
    await db.query(
      "insert into public.session_participants(session_id, role, reconnect_token_hash) values ($1, 'sender', $2)",
      [session, "a".repeat(64)],
    );
    await db.query(
      "insert into public.questions(session_id, question_text) values ($1, 'q')",
      [session],
    );
    await db.query(
      "insert into public.session_answer_state(session_id) values ($1)",
      [session],
    );
    await db.query("delete from public.sessions where id = $1", [session]);
    for (const table of [
      "session_participants",
      "questions",
      "session_answer_state",
    ]) {
      assert.equal(
        (await db.query(`select * from public.${table}`)).rows.length,
        0,
      );
    }
  }));

test("prepared answers preserve exact text while modification timestamps update", async () =>
  fixture(async () => {
    const exact = "  Original answer.\nSecond line.\t  ";
    const {
      rows: [row],
    } = await db.query(
      "insert into public.prepared_qa(question, answer, updated_at) values ('q', $1, '2000-01-01') returning id",
      [exact],
    );
    const {
      rows: [changed],
    } = await db.query(
      "update public.prepared_qa set is_active = false where id = $1 returning answer, updated_at",
      [row.id],
    );
    assert.equal(changed.answer, exact);
    assert.ok(new Date(changed.updated_at).getUTCFullYear() > 2000);
  }));

test("document chunks enforce ordering, metadata, and parent deletion", async () =>
  fixture(async () => {
    const {
      rows: [document],
    } = await db.query(
      "insert into public.reference_documents(original_filename, storage_path, file_type) values ('notes.txt', 'private/notes.txt', 'text/plain') returning id",
    );
    await db.query(
      "insert into public.reference_document_chunks(document_id, content, chunk_index) values ($1, 'section', 0)",
      [document.id],
    );
    await expectDatabaseError(
      "insert into public.reference_document_chunks(document_id, content, chunk_index) values ($1, 'duplicate', 0)",
      "23505",
      [document.id],
    );
    await expectDatabaseError(
      "update public.reference_documents set metadata = '[]'::jsonb",
      "23514",
    );
    await db.query("delete from public.reference_documents where id = $1", [
      document.id,
    ]);
    assert.equal(
      (await db.query("select * from public.reference_document_chunks")).rows
        .length,
      0,
    );
  }));

test("private bucket resists existing permissive policies without affecting other buckets", async () =>
  fixture(async () => {
    const bucket = (
      await db.query(
        "select * from storage.buckets where id = 'reference-documents'",
      )
    ).rows[0];
    assert.equal(bucket.public, false);
    await db.exec(
      "insert into storage.buckets values ('unrelated', 'unrelated', false); insert into storage.objects(bucket_id, name) values ('reference-documents', 'private.txt'), ('unrelated', 'other.txt')",
    );
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set local role ${role}`);
      assert.deepEqual(
        (await db.query("select id from storage.buckets")).rows,
        [{ id: "unrelated" }],
      );
      assert.deepEqual(
        (await db.query("select name from storage.objects")).rows,
        [{ name: "other.txt" }],
      );
      await expectDatabaseError(
        "insert into storage.objects(bucket_id, name) values ('reference-documents', 'forbidden.txt')",
        "42501",
      );
      await db.exec("reset role");
    }
  }));
