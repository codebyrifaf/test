import assert from "node:assert/strict";
import { beforeEach, afterEach, mock, test } from "node:test";
import { GET } from "../src/app/api/session/availability/route";
import { getDashboardAvailability } from "../src/lib/server/dashboard";
const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;
const original = names.map((name) => process.env[name]);
const sessionId = "12345678-1234-4123-8123-123456789abc";
const token = "a".repeat(64);
const participant = {
  role: "sender",
  explicitly_quit: false,
  reconnect_token_hash: token,
  token_revoked_at: null as string | null,
  token_expires_at: null as string | null,
};
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://relay-tests.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_availability_fixture";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_availability_fixture";
});
afterEach(() => {
  mock.restoreAll();
  names.forEach((name, index) => {
    if (original[index] === undefined) delete process.env[name];
    else process.env[name] = original[index];
  });
});
function fixture(status: "waiting" | "active" | null, rows = [participant]) {
  const paths: string[] = [];
  mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      assert.equal(init?.cache, "no-store");
      if (url.pathname.endsWith("/rpc/relay_session_availability"))
        return Response.json({ available: status !== null });
      if (url.pathname === "/rest/v1/sessions") {
        assert.equal(url.searchParams.get("select"), "id,status");
        assert.equal(url.searchParams.get("status"), "neq.terminated");
        return Response.json(
          status
            ? [
                {
                  id: sessionId,
                  status,
                  session_code: "private-code",
                  answer_text: "private-answer",
                },
              ]
            : [],
        );
      }
      assert.equal(url.pathname, "/rest/v1/session_participants");
      assert.equal(url.searchParams.get("session_id"), `eq.${sessionId}`);
      return Response.json(rows);
    },
  );
  return paths;
}
for (const status of [null, "waiting", "active"] as const) {
  test(`anonymous dashboard reports ${status ?? "none"} without private fields`, async () => {
    const rows =
      status === "active"
        ? [
            participant,
            {
              ...participant,
              role: "viewer",
              reconnect_token_hash: "b".repeat(64),
            },
          ]
        : [participant];
    const paths = fixture(status, rows);
    const response = await GET(
      new Request("http://relay.test/api/session/availability"),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.deepEqual(await response.json(), {
      available: status === null,
      status: status ?? "none",
      senderOccupied: status !== null,
      viewerOccupied: status === "active",
      senderQuit: false,
      viewerQuit: false,
      ownedRoles: [],
    });
    assert.equal(paths[0], "/rest/v1/rpc/relay_session_availability");
  });
}
for (const failureAt of ["cleanup", "status", "participants"]) {
  test(`${failureAt} failure never claims session creation is available`, async () => {
    mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (failureAt !== "cleanup" && path.includes("/rpc/"))
        return Response.json({ available: false });
      if (failureAt === "participants" && path.endsWith("/sessions"))
        return Response.json([{ id: sessionId, status: "waiting" }]);
      return Response.json(
        { code: "XX000", message: "private database detail" },
        { status: 500 },
      );
    });
    const response = await GET(
      new Request("http://relay.test/api/session/availability"),
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "DATABASE_UNAVAILABLE");
    assert.equal(Object.hasOwn(body, "available"), false);
    assert.ok(!JSON.stringify(body).includes("private database detail"));
  });
}
test("ownership requires the matching role-scoped credential hash; unrelated hashes own nothing", async () => {
  fixture("active", [
    participant,
    { ...participant, role: "viewer", reconnect_token_hash: "b".repeat(64) },
  ]);
  const sender = await getDashboardAvailability(async (role) =>
    role === "sender" ? token : null,
  );
  assert.deepEqual(sender.ownedRoles, ["sender"]);
  const wrongRole = await getDashboardAvailability(async (role) =>
    role === "viewer" ? token : null,
  );
  assert.deepEqual(wrongRole.ownedRoles, []);
  const unknown = await getDashboardAvailability(async () => "c".repeat(64));
  assert.deepEqual(unknown.ownedRoles, []);
  assert.ok(!JSON.stringify(sender).includes(token));
  assert.ok(!JSON.stringify(sender).includes(sessionId));
});
for (const change of [
  { explicitly_quit: true },
  { token_revoked_at: new Date().toISOString() },
  { token_expires_at: new Date(Date.now() - 60000).toISOString() },
]) {
  test(`quit/revoked/expired credentials cannot own or free an occupied role: ${Object.keys(change)[0]}`, async () => {
    fixture("waiting", [{ ...participant, ...change }]);
    const result = await getDashboardAvailability(async () => token);
    assert.equal(result.available, false);
    assert.equal(result.senderOccupied, true);
    assert.deepEqual(result.ownedRoles, []);
    assert.equal(result.senderQuit, "explicitly_quit" in change);
  });
}
test("viewer quitting keeps both slots occupied and preserves only sender ownership", async () => {
  fixture("active", [
    participant,
    {
      ...participant,
      role: "viewer",
      explicitly_quit: true,
      reconnect_token_hash: "b".repeat(64),
    },
  ]);
  const result = await getDashboardAvailability(async (role) =>
    role === "sender" ? token : "b".repeat(64),
  );
  assert.equal(result.viewerOccupied, true);
  assert.equal(result.viewerQuit, true);
  assert.equal(result.available, false);
  assert.deepEqual(result.ownedRoles, ["sender"]);
});
