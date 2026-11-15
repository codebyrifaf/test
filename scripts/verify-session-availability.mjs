// Live regression: uses only temporary owned fixtures; never tests admin routes or applies SQL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
const requireBrowser = createRequire(
  new URL("../.verification/package.json", import.meta.url),
);
const { chromium } = requireBrowser("playwright-core");
nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((item) => item && item.family === "IPv4" && !item.internal)
  .map((item) => item.address);
assert.ok(
  addresses.includes("192.168.1.138"),
  "The LAN address changed; update the test origin and Next allowedDevOrigins before testing.",
);
const origins = [
  "http://localhost:3000",
  "http://192.168.1.138:3000",
  "http://localhost:3000",
];
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const contexts = await Promise.all(
  origins.map(() =>
    browser.newContext({ viewport: { width: 1200, height: 900 } }),
  ),
);
const runtimeErrors = [];
contexts.forEach((context) =>
  context.on("page", (page) =>
    page.on("pageerror", () => runtimeErrors.push(true)),
  ),
);
const pages = await Promise.all(contexts.map((context) => context.newPage()));
const ownedSessions = new Set(),
  qaId = randomUUID();
const results = [];
let stage = "preflight";
const mark = (name) => {
  results.push({ name, passed: true });
  console.log("PASS: " + name);
};
const create = (page) =>
  page.getByRole("button", { name: "Create Session", exact: true });
async function waitState(page, text) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="global-session-status"]')
        ?.textContent === expected,
    text,
    { timeout: 15000 },
  );
}
async function enabled(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Create Session" && !button.disabled,
      ),
    undefined,
    { timeout: 15000 },
  );
}
async function noCreate(page) {
  assert.equal(await page.getByTestId("create-sender-card").count(), 0);
  assert.equal(await create(page).count(), 0);
}
async function initial(page) {
  await waitState(page, "No active session");
  await enabled(page);
  assert.equal(await page.getByTestId("create-sender-card").count(), 1);
  assert.equal(await page.getByTestId("join-viewer-card").count(), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "Join Session", exact: true })
      .isDisabled(),
    true,
  );
}
async function request(index, path, body, method = "POST") {
  const response = await contexts[index].request.fetch(origins[index] + path, {
    method,
    data: body,
    headers: { Origin: origins[index] },
  });
  return { status: response.status(), body: await response.json() };
}
async function home(index) {
  const page = await contexts[index].newPage();
  await page.goto(origins[index]);
  return page;
}
try {
  for (let index = 0; index < 3; index++) {
    const result = await request(
      index,
      "/api/session/availability",
      undefined,
      "GET",
    );
    assert.equal(result.status, 200);
    assert.equal(
      result.body.available,
      true,
      "Existing session is active; test did not alter it.",
    );
    assert.deepEqual(result.body.ownedRoles, []);
  }
  stage = "loading and initial cards";
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await pages[1].route("**/api/session/availability", async (route) => {
    await gate;
    await route.continue();
  });
  await Promise.all(pages.map((page, index) => page.goto(origins[index])));
  await waitState(pages[1], "Checking session availability…");
  await noCreate(pages[1]);
  release();
  await pages[1].unrouteAll({ behavior: "wait" });
  await Promise.all(pages.map(initial));
  mark(
    "all three dashboards show initial cards; creation is unavailable while loading; initial Join is disabled",
  );

  stage = "direct navigation and forged ownership";
  await pages[2].goto(origins[2] + "/sender");
  assert.equal(
    (await request(2, "/api/session/sender", undefined, "GET")).status,
    401,
  );
  assert.equal(
    (await request(2, "/api/session/availability", undefined, "GET")).body
      .available,
    true,
  );
  await pages[2].goto(origins[2]);
  await initial(pages[2]);
  await contexts[2].addCookies([
    {
      name: "relay_sender",
      value: "A".repeat(43),
      url: origins[2],
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  mark(
    "opening /sender alone does not create/reserve a session; missing credentials are denied",
  );

  stage = "failed checks recover automatically";
  await pages[1].route("**/api/session/availability", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Availability test interruption",
        },
      }),
    }),
  );
  await waitState(pages[1], "Session availability unavailable");
  await noCreate(pages[1]);
  await pages[1].unrouteAll({ behavior: "wait" });
  await initial(pages[1]);
  mark("failed checks hide actionable creation and recover through polling");

  stage = "sender creation and stale response protection";
  let releaseStale, enteredStale;
  const staleGate = new Promise((resolve) => {
    releaseStale = resolve;
  });
  const staleEntered = new Promise((resolve) => {
    enteredStale = resolve;
  });
  let intercepted = false;
  await pages[2].route("**/api/session/availability", async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    const oldResponse = await route.fetch();
    enteredStale();
    await staleGate;
    try {
      await route.fulfill({ response: oldResponse });
    } catch {
      /* Correctly aborted by the newer refresh. */
    }
  });
  await staleEntered;
  await create(pages[0]).click();
  await pages[0].waitForURL("**/sender");
  const sender = await request(0, "/api/session/sender", undefined, "GET");
  assert.equal(sender.status, 200);
  ownedSessions.add(sender.body.sessionId);
  await pages[2].evaluate(() => window.dispatchEvent(new Event("focus")));
  await Promise.all(
    [pages[1], pages[2]].map((page) =>
      waitState(page, "Sender active — waiting for viewer"),
    ),
  );
  for (const page of [pages[1], pages[2]]) {
    await noCreate(page);
    assert.equal(await page.getByTestId("join-viewer-card").count(), 1);
  }
  releaseStale();
  await pages[2].unrouteAll({ behavior: "wait" });
  await pages[2].waitForTimeout(300);
  await noCreate(pages[2]);
  assert.equal((await request(1, "/api/session/create", {})).status, 409);
  const dashboards = [await home(0), pages[1], pages[2]];
  await waitState(dashboards[0], "Sender active — waiting for viewer");
  assert.equal(await dashboards[0].getByTestId("sender-owner-card").count(), 1);
  await noCreate(dashboards[0]);
  assert.equal(await dashboards[0].getByTestId("join-viewer-card").count(), 0);
  assert.deepEqual(
    (await request(2, "/api/session/availability", undefined, "GET")).body
      .ownedRoles,
    [],
  );
  mark(
    "creation hides sender cards across origins; owner sees Sender Active; stale snapshots and forged cookies cannot restore creation or ownership",
  );

  stage = "viewer joins and both roles are occupied";
  await pages[1]
    .getByLabel("Private session code")
    .fill(sender.body.sessionCode);
  assert.equal(
    await pages[1]
      .getByRole("button", { name: "Join Session", exact: true })
      .isEnabled(),
    true,
  );
  await pages[1]
    .getByRole("button", { name: "Join Session", exact: true })
    .click();
  await pages[1].waitForURL("**/viewer");
  dashboards[1] = await home(1);
  await Promise.all(
    dashboards.map((page) =>
      waitState(page, "Session in progress — both roles are occupied"),
    ),
  );
  for (const page of dashboards) {
    await noCreate(page);
    assert.equal(await page.getByTestId("join-viewer-card").count(), 0);
  }
  assert.equal(
    await dashboards[0]
      .getByRole("link", { name: "Return to sender workspace" })
      .count(),
    1,
  );
  assert.equal(
    await dashboards[1]
      .getByRole("link", { name: "Return to viewer workspace" })
      .count(),
    1,
  );
  assert.equal(
    await dashboards[2].locator('[data-testid$="owner-card"]').count(),
    0,
  );
  for (let index = 0; index < 3; index++) {
    const result = (
      await request(index, "/api/session/availability", undefined, "GET")
    ).body;
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "available",
        "status",
        "senderOccupied",
        "viewerOccupied",
        "senderQuit",
        "viewerQuit",
        "ownedRoles",
      ].sort(),
    );
    assert.ok(!JSON.stringify(result).includes(sender.body.sessionCode));
  }
  mark(
    "viewer joins; A/B retain their own workspace links; C has neither action card; public dashboard data contains no private code or credentials",
  );

  stage = "existing answer flow and reconnection";
  assert.equal(
    (await request(0, "/api/session/viewer", undefined, "GET")).status,
    401,
  );
  assert.equal(
    (await request(1, "/api/session/sender", undefined, "GET")).status,
    401,
  );
  // Answers come only from the admin memory; any delivered answer proves the
  // flow (an empty memory yields "Not in memory" without an AI request).
  const question = "Dashboard regression " + qaId;
  await pages[0].getByLabel("Your question").fill(question);
  await pages[0]
    .getByRole("button", { name: "Submit Question", exact: true })
    .click();
  const ticker = pages[1].getByTestId("answer-ticker");
  await ticker.waitFor({ timeout: 20000 });
  const answer = (await ticker.textContent())?.trim();
  assert.ok(answer);
  // The dashboard observers open extra tabs; Chrome suspends RAF in hidden tabs.
  // Bring the actual viewer forward before asserting motion.
  await pages[1].bringToFront();
  await ticker.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const x = await ticker.evaluate(
    (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
  );
  await pages[1].waitForFunction(
    (previous) => {
      const element = document.querySelector('[data-testid="answer-ticker"]');
      return (
        element &&
        new DOMMatrix(getComputedStyle(element).transform).m41 < previous
      );
    },
    x,
    { timeout: 5000 },
  );
  await pages[1].getByLabel("Scrolling speed").fill("400");
  assert.equal(
    Object.hasOwn(
      (await request(0, "/api/session/sender", undefined, "GET")).body,
      "answer",
    ),
    false,
  );
  await pages[1].reload();
  await ticker.waitFor({ timeout: 15000 });
  assert.equal((await ticker.textContent())?.trim(), answer);
  mark(
    "cross-origin role authorization, answer delivery, scrolling, speed control and reconnect remain functional",
  );

  stage = "one participant quits without freeing a role";
  await pages[1]
    .getByRole("button", { name: "Quit session", exact: true })
    .click();
  await Promise.all(
    dashboards.map((page) =>
      waitState(page, "Viewer has quit — waiting for the session to close"),
    ),
  );
  assert.equal(await dashboards[0].getByTestId("sender-owner-card").count(), 1);
  assert.equal(await dashboards[1].getByTestId("viewer-owner-card").count(), 0);
  for (const page of dashboards) {
    await noCreate(page);
    assert.equal(await page.getByTestId("join-viewer-card").count(), 0);
  }
  assert.equal(
    (await request(2, "/api/session/join", { code: sender.body.sessionCode }))
      .status,
    409,
  );
  assert.equal(
    (await request(1, "/api/session/viewer", undefined, "GET")).status,
    401,
  );
  assert.equal(
    (await request(0, "/api/session/sender", undefined, "GET")).status,
    200,
  );
  mark(
    "viewer quit removes its ownership but does not free either slot; authorized sender retains access",
  );
  await pages[0]
    .getByRole("button", { name: "Quit session", exact: true })
    .click();
  await Promise.all(dashboards.map(initial));
  mark(
    "both quits automatically restore the original cards on all three dashboards",
  );

  stage = "two simultaneous creates and conflict refresh";
  const contenders = dashboards.slice(0, 2);
  let releaseRace;
  const raceGate = new Promise((resolve) => {
    releaseRace = resolve;
  });
  let arrived = 0;
  for (const page of contenders)
    await page.route("**/api/session/create", async (route) => {
      arrived++;
      if (arrived === 2) releaseRace();
      await raceGate;
      await route.continue();
    });
  const responses = contenders.map((page) =>
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/session/create",
    ),
  );
  await Promise.all(contenders.map((page) => create(page).click()));
  const actual = await Promise.all(responses);
  assert.deepEqual(
    actual.map((response) => response.status()).sort(),
    [201, 409],
  );
  const winner = actual.findIndex((response) => response.status() === 201),
    loser = 1 - winner;
  const created = await actual[winner].json();
  ownedSessions.add(created.sessionId);
  await dashboards[winner].waitForURL("**/sender");
  await dashboards[loser]
    .getByRole("alert")
    .filter({ hasText: "Another session is already open" })
    .waitFor({ timeout: 10000 });
  await waitState(dashboards[loser], "Sender active — waiting for viewer");
  await noCreate(dashboards[loser]);
  for (const page of contenders) await page.unrouteAll({ behavior: "wait" });
  mark(
    "simultaneous Create requests yield exactly one 201 and one 409; losing dashboard refreshes and hides the sender card",
  );

  stage = "controlled expiry restores every dashboard";
  await dashboards[winner].close();
  dashboards[winner] = await home(winner);
  await Promise.all(
    dashboards.map((page) =>
      waitState(page, "Sender active — waiting for viewer"),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const agedSession = await db
    .from("sessions")
    .update({ created_at: new Date(Date.now() - 3600000).toISOString() })
    .eq("id", created.sessionId);
  assert.equal(agedSession.error, null);
  const agedPresence = await db
    .from("session_participants")
    .update({
      last_seen_at: new Date(Date.now() - 12 * 60000).toISOString(),
      last_disconnected_at: new Date(Date.now() - 11 * 60000).toISOString(),
      connection_status: "disconnected",
    })
    .eq("session_id", created.sessionId);
  assert.equal(agedPresence.error, null);
  await Promise.all(dashboards.map(initial));
  const expired = await db
    .from("sessions")
    .select("status")
    .eq("id", created.sessionId)
    .single();
  assert.equal(expired.data?.status, "terminated");
  mark(
    "real Supabase expiry using controlled test-fixture timestamps restores initial cards on all origins",
  );
  assert.equal(runtimeErrors.length, 0);
  mark("no browser runtime errors and no admin-panel verification");
} catch (error) {
  const diagnostics = await Promise.all(
    pages.map(async (page) => ({
      origin: new URL(page.url()).origin,
      status: await page
        .getByTestId("global-session-status")
        .textContent({ timeout: 500 })
        .catch(() => null),
      createCards: await page
        .getByTestId("create-sender-card")
        .count()
        .catch(() => null),
    })),
  );
  results.push({
    name: stage,
    passed: false,
    error: String(error.message).split("\n")[0],
    diagnostics,
  });
  console.error("FAILED: " + stage);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const id of ownedSessions) {
    const ended = await db
      .from("sessions")
      .update({ status: "terminated", terminated_at: new Date().toISOString() })
      .eq("id", id)
      .neq("status", "terminated");
    const removed = await db.from("sessions").delete().eq("id", id);
    if (ended.error || removed.error) {
      console.error("Test session cleanup failed");
      process.exitCode = 1;
    }
  }
  await writeFile(
    ".verification/session-availability-results.json",
    JSON.stringify({ origins, results }, null, 2),
  );
}
