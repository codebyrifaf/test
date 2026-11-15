import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

let db;
const sender = "a".repeat(64);
const viewer = "b".repeat(64);
before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create schema storage; create table storage.buckets(id text primary key, name text, public boolean);
    create table storage.objects(id uuid, bucket_id text, name text);
    alter table storage.buckets enable row level security; alter table storage.objects enable row level security;`);
  for (const file of [
    "20261103192919_relay_database_foundation.sql",
    "20261103192921_private_reference_storage.sql",
    "20261103195630_relay_application.sql",
  ]) {
    await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  }
});
after(async () => {
  await db?.close();
});
async function rpc(name, args = []) {
  const { rows } = await db.query(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`,
    args,
  );
  return rows[0].result;
}
async function fixture(run) {
  await db.exec("begin");
  try {
    await run();
  } finally {
    await db.exec("rollback");
  }
}
async function expectError(run, message) {
  await db.exec("savepoint expected_failure");
  try {
    await assert.rejects(
      run,
      message instanceof RegExp ? message : { code: message },
    );
  } finally {
    await db.exec("rollback to savepoint expected_failure");
  }
}
async function participants() {
  const session = await rpc("relay_create_session", [
    "test-code-123456789",
    sender,
  ]);
  await rpc("relay_join_session", ["test-code-123456789", viewer]);
  return session;
}

test("application migration applies with vector indexes and service-only RPC access", async () =>
  fixture(async () => {
    await db.exec("set local role anon");
    await expectError(() => rpc("relay_session_availability"), "42501");
    await db.exec("reset role; set local role service_role");
    assert.deepEqual(await rpc("relay_session_availability"), {
      available: true,
    });
  }));

test("create, join, role authorization, second-session blocking and explicit quits", async () =>
  fixture(async () => {
    await db.exec("set local role service_role");
    const session = await participants();
    await expectError(
      () =>
        rpc("relay_create_session", ["second-code-123456789", "c".repeat(64)]),
      /RELAY_SESSION_BUSY/,
    );
    await expectError(
      () => rpc("relay_join_session", ["test-code-123456789", "c".repeat(64)]),
      /RELAY_VIEWER_TAKEN/,
    );
    await expectError(
      () => rpc("relay_session_snapshot", [sender, "viewer", false]),
      /RELAY_UNAUTHORIZED/,
    );
    const first = await rpc("relay_quit_session", [sender, "sender"]);
    assert.deepEqual(first, { quit: true, terminated: false });
    assert.equal(
      (await rpc("relay_session_snapshot", [viewer, "viewer", true])).sessionId,
      session.sessionId,
    );
    assert.deepEqual(await rpc("relay_quit_session", [viewer, "viewer"]), {
      quit: true,
      terminated: true,
    });
    assert.deepEqual(await rpc("relay_session_availability"), {
      available: true,
    });
  }));

test("latest question wins atomically; sender never receives answer text; acknowledgment updates status", async () =>
  fixture(async () => {
    const session = await participants();
    const q1 = await rpc("relay_submit_question", [
      sender,
      "first",
      randomUUID(),
    ]);
    const claim1 = await rpc("relay_claim_question", [session.sessionId]);
    const requestId = randomUUID();
    const q2 = await rpc("relay_submit_question", [
      sender,
      "second",
      requestId,
    ]);
    assert.ok(q2.sequence > q1.sequence);
    assert.deepEqual(
      await rpc("relay_submit_question", [sender, "second", requestId]),
      q2,
    );
    assert.equal(
      await rpc("relay_finish_question", [
        q1.id,
        claim1.leaseId,
        "stale answer",
        null,
      ]),
      false,
    );
    const claim2 = await rpc("relay_claim_question", [session.sessionId]);
    assert.equal(await rpc("relay_claim_question", [session.sessionId]), null);
    const exact = "  Approved answer.\nVerbatim.  ";
    assert.equal(
      await rpc("relay_finish_question", [q2.id, claim2.leaseId, exact, null]),
      true,
    );
    const senderState = await rpc("relay_session_snapshot", [
      sender,
      "sender",
      true,
    ]);
    assert.ok(!JSON.stringify(senderState).includes("Approved answer"));
    assert.equal(Object.hasOwn(senderState, "answer"), false);
    assert.equal(senderState.question.delivered, false);
    assert.equal(
      (await rpc("relay_session_snapshot", [viewer, "viewer", true])).answer
        .text,
      exact,
    );
    await rpc("relay_ack_answer", [viewer, q2.id]);
    assert.equal(
      (await rpc("relay_session_snapshot", [sender, "sender", false])).question
        .delivered,
      true,
    );
  }));

test("AI failure preserves the previous answer and exposes only an error code to sender", async () =>
  fixture(async () => {
    const session = await participants();
    const first = await rpc("relay_submit_question", [
      sender,
      "first",
      randomUUID(),
    ]);
    const claim1 = await rpc("relay_claim_question", [session.sessionId]);
    await rpc("relay_finish_question", [
      first.id,
      claim1.leaseId,
      "valid earlier answer",
      null,
    ]);
    const second = await rpc("relay_submit_question", [
      sender,
      "second",
      randomUUID(),
    ]);
    const claim2 = await rpc("relay_claim_question", [session.sessionId]);
    await rpc("relay_finish_question", [
      second.id,
      claim2.leaseId,
      null,
      "AI_QUOTA",
    ]);
    const viewerState = await rpc("relay_session_snapshot", [
      viewer,
      "viewer",
      false,
    ]);
    assert.equal(viewerState.answer.id, first.id);
    assert.ok(!JSON.stringify(viewerState).includes("AI_QUOTA"));
    assert.equal(
      (await rpc("relay_session_snapshot", [sender, "sender", false])).question
        .errorCode,
      "AI_QUOTA",
    );
  }));

test("stale presence starts inactivity; reconnect cancels it; expiration allows atomic replacement", async () =>
  fixture(async () => {
    const session = await participants();
    await db.query(
      "update public.sessions set created_at = now() - interval '1 hour' where id = $1",
      [session.sessionId],
    );
    await db.query(
      "update public.session_participants set last_seen_at = now() - interval '2 minutes' where session_id = $1",
      [session.sessionId],
    );
    await rpc("relay_session_availability");
    let row = (
      await db.query(
        "select both_disconnected_at, inactivity_deadline_at from public.sessions where id = $1",
        [session.sessionId],
      )
    ).rows[0];
    assert.ok(row.both_disconnected_at && row.inactivity_deadline_at);
    await rpc("relay_session_snapshot", [sender, "sender", true]);
    row = (
      await db.query(
        "select both_disconnected_at from public.sessions where id = $1",
        [session.sessionId],
      )
    ).rows[0];
    assert.equal(row.both_disconnected_at, null);
    await db.query(
      "update public.session_participants set last_seen_at = now() - interval '12 minutes', last_disconnected_at = now() - interval '11 minutes', connection_status = 'disconnected' where session_id = $1",
      [session.sessionId],
    );
    const replacement = await rpc("relay_create_session", [
      "replacement-code-1234",
      "c".repeat(64),
    ]);
    assert.notEqual(replacement.sessionId, session.sessionId);
    await expectError(
      () => rpc("relay_session_snapshot", [viewer, "viewer", true]),
      /RELAY_SESSION_ENDED/,
    );
  }));

test("normal termination deletes temporary answers", async () =>
  fixture(async () => {
    const session = await participants();
    const q = await rpc("relay_submit_question", [
      sender,
      "test",
      randomUUID(),
    ]);
    const claim = await rpc("relay_claim_question", [session.sessionId]);
    await rpc("relay_finish_question", [
      q.id,
      claim.leaseId,
      "temporary",
      null,
    ]);
    await rpc("relay_quit_session", [sender, "sender"]);
    await rpc("relay_quit_session", [viewer, "viewer"]);
    assert.equal(
      (await db.query("select * from public.session_answer_state")).rows.length,
      0,
    );
  }));

test("ending a session after one quit (same update the app sends) closes it for both", async () =>
  fixture(async () => {
    await db.exec("set local role service_role");
    const session = await participants();
    const q = await rpc("relay_submit_question", [
      sender,
      "test",
      randomUUID(),
    ]);
    const claim = await rpc("relay_claim_question", [session.sessionId]);
    await rpc("relay_finish_question", [q.id, claim.leaseId, "temporary", null]);
    await rpc("relay_quit_session", [viewer, "viewer"]);
    // The session stays open after one quit until it is ended.
    assert.equal((await rpc("relay_session_availability")).available, false);
    const { rows: before } = await db.query(
      "select created_at from public.sessions where id = $1",
      [session.sessionId],
    );
    const ended = await db.query(
      "update public.sessions set status = 'terminated', terminated_at = $2 where id = $1 and status <> 'terminated' returning id",
      [session.sessionId, before[0].created_at],
    );
    assert.equal(ended.rows.length, 1);
    assert.equal(
      (await db.query("select * from public.session_answer_state")).rows.length,
      0,
    );
    await expectError(
      () => rpc("relay_session_snapshot", [sender, "sender", false]),
      /RELAY_SESSION_ENDED/,
    );
    await expectError(
      () => rpc("relay_submit_question", [sender, "again", randomUUID()]),
      /RELAY_SESSION_ENDED/,
    );
    assert.equal((await rpc("relay_session_availability")).available, true);
    await rpc("relay_create_session", ["next-code-123456789", "c".repeat(64)]);
  }));

test("prepared aliases detect duplicates and return exact unchanged answers", async () =>
  fixture(async () => {
    const original = "  exact answer\nwith whitespace  ";
    await db.query(
      "insert into public.prepared_qa(question, answer, alternative_questions) values ('Original question', $1, array['Alternate phrasing'])",
      [original],
    );
    const rows = await db.query(
      "select * from public.relay_exact_answer('  ALTERNATE   phrasing ')",
    );
    assert.equal(rows.rows[0].answer, original);
    await expectError(
      () =>
        db.query(
          "insert into public.prepared_qa(question, answer) values ('alternate phrasing', 'duplicate')",
        ),
      "23505",
    );
    await db.exec("update public.prepared_qa set is_active = false");
    assert.equal(
      (
        await db.query(
          "select * from public.relay_exact_answer('Original question')",
        )
      ).rows.length,
      0,
    );
  }));

test("keyword search works without embeddings and vector search filters embedding models", async () =>
  fixture(async () => {
    await db.exec(
      "insert into public.prepared_qa(question, answer) values ('What is a university?', 'A university answer')",
    );
    const keyword = await db.query(
      "select * from public.relay_search_prepared('university', null, null)",
    );
    assert.equal(keyword.rows.length, 1);
    const embedding = JSON.stringify([1, ...Array(767).fill(0)]);
    await db.query(
      "update public.prepared_qa set embedding = $1::extensions.vector, embedding_model = 'test-model'",
      [embedding],
    );
    assert.equal(
      (
        await db.query(
          "select * from public.relay_search_prepared('unrelated', $1::extensions.vector, 'test-model')",
          [embedding],
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await db.query(
          "select * from public.relay_search_prepared('unrelated', $1::extensions.vector, 'different-model')",
          [embedding],
        )
      ).rows.length,
      0,
    );
  }));

test("persisted rate limits enforce a request window", async () =>
  fixture(async () => {
    assert.equal(await rpc("relay_rate_limit", ["test", 2, 60]), true);
    assert.equal(await rpc("relay_rate_limit", ["test", 2, 60]), true);
    assert.equal(await rpc("relay_rate_limit", ["test", 2, 60]), false);
  }));

test("expired processing leases recover with a new fence and reject the abandoned worker", async () =>
  fixture(async () => {
    const session = await participants();
    const question = await rpc("relay_submit_question", [
      sender,
      "recover work",
      randomUUID(),
    ]);
    const first = await rpc("relay_claim_question", [session.sessionId]);
    await db.query(
      "update public.questions set lease_until = now() - interval '1 second' where id = $1",
      [question.id],
    );
    const second = await rpc("relay_claim_question", [session.sessionId]);
    assert.notEqual(second.leaseId, first.leaseId);
    assert.equal(
      await rpc("relay_finish_question", [
        question.id,
        first.leaseId,
        "abandoned result",
        null,
      ]),
      false,
    );
    assert.equal(
      await rpc("relay_finish_question", [
        question.id,
        second.leaseId,
        "recovered result",
        null,
      ]),
      true,
    );
    assert.equal(
      (await rpc("relay_session_snapshot", [viewer, "viewer", false])).answer
        .text,
      "recovered result",
    );
  }));

test("repeatedly interrupted workers stop after three claims", async () =>
  fixture(async () => {
    const session = await participants();
    const question = await rpc("relay_submit_question", [
      sender,
      "interrupted work",
      randomUUID(),
    ]);
    for (let i = 0; i < 3; i++) {
      assert.ok(await rpc("relay_claim_question", [session.sessionId]));
      await db.query(
        "update public.questions set lease_until = now() - interval '1 second' where id = $1",
        [question.id],
      );
    }
    assert.equal(await rpc("relay_claim_question", [session.sessionId]), null);
    const state = await rpc("relay_session_snapshot", [
      sender,
      "sender",
      false,
    ]);
    assert.equal(state.question.status, "failed");
    assert.equal(state.question.errorCode, "PROCESSING_INTERRUPTED");
    assert.equal(
      (await rpc("relay_session_snapshot", [viewer, "viewer", false])).answer,
      null,
    );
  }));

test("expiration denies old answer delivery and removes temporary state", async () =>
  fixture(async () => {
    const session = await participants();
    const question = await rpc("relay_submit_question", [
      sender,
      "expires",
      randomUUID(),
    ]);
    const claim = await rpc("relay_claim_question", [session.sessionId]);
    await rpc("relay_finish_question", [
      question.id,
      claim.leaseId,
      "expired answer",
      null,
    ]);
    await db.query(
      "update public.sessions set created_at = now() - interval '1 hour' where id = $1",
      [session.sessionId],
    );
    await db.query(
      "update public.session_participants set last_seen_at = now() - interval '12 minutes' where session_id = $1",
      [session.sessionId],
    );
    await expectError(
      () => rpc("relay_session_snapshot", [viewer, "viewer", true]),
      /RELAY_SESSION_ENDED/,
    );
    assert.deepEqual(await rpc("relay_session_availability"), {
      available: true,
    });
    assert.equal(
      (
        await db.query(
          "select session_id from public.session_answer_state where session_id = $1",
          [session.sessionId],
        )
      ).rows.length,
      0,
    );
  }));
