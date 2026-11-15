import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  requireSupabaseKey,
  requireSupabaseUrl,
  SupabaseConfigurationError,
} from "../src/lib/supabase/environment";
import { createPublicSupabaseClient } from "../src/lib/supabase/public-client";
import { checkSupabaseConnection } from "../src/lib/supabase/health";
import { GET } from "../src/app/api/health/supabase/route";

const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;
const initial = names.map((name) => process.env[name]);

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://relay-tests.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_test_fixture";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_fixture";
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request in isolated test");
  });
});

afterEach(() => {
  mock.restoreAll();
  names.forEach((name, index) => {
    if (initial[index] === undefined) delete process.env[name];
    else process.env[name] = initial[index];
  });
});

test("missing variables produce a configuration status without network access", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("Should not be called");
  });
  for (const name of names) {
    const previous = process.env[name];
    delete process.env[name];
    assert.equal(await checkSupabaseConnection(), "not_configured");
    process.env[name] = previous;
  }
  assert.equal(calls, 0);
});

test("modern keys are accepted and swapped, legacy, and whitespace keys rejected", () => {
  assert.equal(
    requireSupabaseKey("sb_publishable_fixture", "PUBLIC", "publishable"),
    "sb_publishable_fixture",
  );
  assert.equal(
    requireSupabaseKey("sb_secret_fixture", "PRIVATE", "secret"),
    "sb_secret_fixture",
  );
  for (const value of [
    "sb_secret_fixture",
    "eyJ.legacy.jwt",
    " sb_publishable_fixture",
    "sb_publishable_",
    "sb_publishable_bad value",
  ]) {
    assert.throws(
      () => requireSupabaseKey(value, "PUBLIC", "publishable"),
      SupabaseConfigurationError,
    );
  }
  assert.throws(
    () => requireSupabaseKey("sb_publishable_fixture", "PRIVATE", "secret"),
    SupabaseConfigurationError,
  );
  assert.throws(() => requireSupabaseKey(" ", "PRIVATE", "secret"), {
    issue: "missing",
  });
});

test("URL validation allows HTTPS/custom domains and loopback HTTP only", () => {
  assert.equal(
    requireSupabaseUrl("https://custom.example/"),
    "https://custom.example",
  );
  assert.equal(
    requireSupabaseUrl("http://127.0.0.1:54321"),
    "http://127.0.0.1:54321",
  );
  for (const value of [
    "invalid",
    "http://remote.example",
    "ftp://remote.example",
    "https://user:password@example.com",
    "https://example.com/rest/v1",
    "https://example.com/?key=private",
    "https://example.com/#secret",
  ]) {
    assert.throws(() => requireSupabaseUrl(value), SupabaseConfigurationError);
  }
});

test("invalid configuration is sanitized in the public HTTP response", async () => {
  const privateFixture = "sb_secret_never_return_this_fixture";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = privateFixture;
  const response = await GET();
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { status: "invalid_configuration" });
  assert.ok(!text.includes(privateFixture));
});

test("public client uses only the publishable key and returns database denial", async () => {
  delete process.env.SUPABASE_SECRET_KEY;
  const intercept: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), "sb_publishable_test_fixture");
    return new Response(
      JSON.stringify({ message: "permission denied", code: "42501" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  mock.method(globalThis, "fetch", intercept);
  const { error } = await createPublicSupabaseClient()
    .from("sessions")
    .select("id");
  assert.equal(error?.code, "42501");
});

test("health success requires a bounded, read-only server query", async () => {
  let calls = 0;
  const intercept: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.pathname, "/rest/v1/sessions");
    assert.equal(url.searchParams.get("select"), "id");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(init?.method, "HEAD");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(
      new Headers(init?.headers).get("apikey"),
      "sb_secret_test_fixture",
    );
    return new Response(null, { status: 200 });
  };
  mock.method(globalThis, "fetch", intercept);
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(calls, 1);
});

test("database and transport errors never leak details or claim success", async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    mock.method(
      globalThis,
      "fetch",
      async () => new Response("internal database details", { status }),
    );
    const response = await GET();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Sensitive internal connection details");
  });
  assert.equal(await checkSupabaseConnection(), "unavailable");
});
