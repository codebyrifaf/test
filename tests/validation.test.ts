import assert from "node:assert/strict";
import test from "node:test";
import { sameOrigin, jsonBody } from "../src/lib/server/validation";
test("same-origin accepts the LAN HTTP Host even when Next uses its bind address", () => {
  assert.doesNotThrow(() =>
    sameOrigin(
      new Request("http://0.0.0.0:3000/api/questions", {
        headers: {
          host: "192.168.1.138:3000",
          origin: "http://192.168.1.138:3000",
        },
      }),
    ),
  );
});
test("cross-origin and spoofed forwarding headers cannot authorize mutations", () => {
  const cases: Record<string, string>[] = [
    { host: "localhost:3000", origin: "https://other.example" },
    {
      host: "localhost:3000",
      origin: "https://other.example",
      "x-forwarded-host": "other.example",
    },
    {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "sec-fetch-site": "cross-site",
    },
    { host: "localhost:3000" },
  ];
  for (const headers of cases)
    assert.throws(
      () =>
        sameOrigin(
          new Request("http://localhost:3000/api/questions", { headers }),
        ),
      { code: "FORBIDDEN_ORIGIN" },
    );
});
test("streamed oversized bodies and malformed JSON fail safely", async () => {
  await assert.rejects(
    jsonBody(
      new Request("http://localhost/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "a".repeat(200) }),
      }),
      100,
    ),
    { code: "PAYLOAD_TOO_LARGE" },
  );
  await assert.rejects(
    jsonBody(
      new Request("http://localhost/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    ),
    { code: "INVALID_INPUT" },
  );
});
