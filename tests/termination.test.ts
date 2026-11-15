import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { POST } from "../src/app/api/session/end/route";
import { endLiveSession } from "../src/lib/server/termination";

const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "APP_ORIGIN",
] as const;
const original = names.map((name) => process.env[name]);
const sessionId = "12345678-1234-4123-8123-123456789abc";
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://relay-tests.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_termination_fixture";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_termination_fixture";
  delete process.env.APP_ORIGIN;
});
afterEach(() => {
  mock.restoreAll();
  names.forEach((name, index) => {
    if (original[index] === undefined) delete process.env[name];
    else process.env[name] = original[index];
  });
});

const unavailable = () =>
  Response.json({ code: "XX000", message: "private" }, { status: 503 });
type Fixture = {
  open?: boolean;
  quit?: boolean;
  createdAt?: string;
  patch?: (attempt: number) => Response;
  statusAfter?: () => string;
};
function database({
  open = true,
  quit = false,
  createdAt = new Date(Date.now() - 60_000).toISOString(),
  patch = () => Response.json([{ id: sessionId }]),
  statusAfter = () => "active",
}: Fixture = {}) {
  const updates: Record<string, unknown>[] = [];
  mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/rpc/relay_rate_limit"))
        return Response.json(true);
      if (url.pathname.endsWith("/rpc/relay_session_availability"))
        return Response.json({ available: !open });
      if (url.pathname === "/rest/v1/session_participants") {
        assert.equal(url.searchParams.get("explicitly_quit"), "eq.true");
        return Response.json(quit ? [{ id: "participant" }] : []);
      }
      assert.equal(url.pathname, "/rest/v1/sessions");
      if (init?.method === "PATCH") {
        assert.equal(url.searchParams.get("id"), `eq.${sessionId}`);
        assert.equal(url.searchParams.get("status"), "neq.terminated");
        updates.push(JSON.parse(String(init.body)));
        return patch(updates.length);
      }
      if (url.searchParams.get("select") === "status")
        return Response.json([{ status: statusAfter() }]);
      return Response.json(open ? [{ id: sessionId, created_at: createdAt }] : []);
    },
  );
  return updates;
}
const end = () =>
  POST(
    new Request("http://relay.test/api/session/end", {
      method: "POST",
      headers: { origin: "http://relay.test" },
    }),
  );

test("a session nobody has quit cannot be ended from the public button", async () => {
  const updates = database({ quit: false });
  const response = await end();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "SESSION_IN_USE");
  assert.deepEqual(updates, []);
});

test("after a participant quits, the public button ends the session", async () => {
  const updates = database({ quit: true });
  const response = await end();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ended: true });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "terminated");
  assert.ok(Date.parse(String(updates[0].terminated_at)) <= Date.now());
});

test("cross-site requests cannot end a session", async () => {
  const updates = database({ quit: true });
  const response = await POST(
    new Request("http://relay.test/api/session/end", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(updates, []);
});

test("the administrator override ends an active session without any quit", async () => {
  const updates = database({ quit: false });
  assert.equal(await endLiveSession({ onlyIfQuit: false }), true);
  assert.equal(updates.length, 1);
});

test("termination time never precedes creation time when clocks differ", async () => {
  const createdAt = new Date(Date.now() + 120_000).toISOString();
  const updates = database({ quit: true, createdAt });
  assert.equal(await endLiveSession({ onlyIfQuit: true }), true);
  assert.equal(updates[0].terminated_at, createdAt);
});

test("with no open session nothing is changed", async () => {
  const updates = database({ open: false });
  assert.equal(await endLiveSession({ onlyIfQuit: false }), false);
  assert.deepEqual(updates, []);
});

test("a lost reply after the database ended the session still reports success", async () => {
  const updates = database({
    quit: true,
    patch: () => unavailable(),
    statusAfter: () => "terminated",
  });
  const response = await end();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ended: true });
  assert.equal(updates.length, 1);
});

test("a temporary database failure is retried once", async () => {
  const updates = database({
    quit: true,
    patch: (attempt) =>
      attempt === 1 ? unavailable() : Response.json([{ id: sessionId }]),
  });
  assert.equal(await endLiveSession({ onlyIfQuit: true }), true);
  assert.equal(updates.length, 2);
});

test("a persistent failure while the session stays open is reported, not hidden", async (t) => {
  t.mock.method(console, "error", () => {});
  const updates = database({ quit: true, patch: () => unavailable() });
  const response = await end();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "DATABASE_UNAVAILABLE");
  assert.equal(updates.length, 2);
});
