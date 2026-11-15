import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  formatWebResults,
  htmlToText,
  searchWeb,
} from "../src/lib/knowledge/web-search";

afterEach(() => {
  mock.restoreAll();
  delete process.env.WEB_SEARCH_CONTACT;
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function network(handler: Handler) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return handler(url, init);
  });
  return requests;
}
const wikiSearch = (titles: string[]) =>
  Response.json({ query: { search: titles.map((title) => ({ title })) } });
// Wikipedia returns pages keyed by page id, not in search order.
const wikiPages = (pages: Record<string, string>) =>
  Response.json({
    query: {
      pages: Object.fromEntries(
        Object.entries(pages).map(([title, extract], i) => [String(100 + i), { title, extract }]),
      ),
    },
  });
const govSearch = (results: { title: string; link: string; description?: string }[]) =>
  Response.json({ results });
const isWikiSearch = (url: URL) =>
  url.hostname === "en.wikipedia.org" && url.searchParams.get("list") === "search";

/** Wikipedia knows Leicester; GOV.UK knows the Student visa guide. */
function standardSources(url: URL) {
  if (url.hostname === "en.wikipedia.org")
    return isWikiSearch(url)
      ? wikiSearch(["Leicester"])
      : wikiPages({ Leicester: "Leicester is a city in England. Its population was 383,116 in 2025." });
  if (url.pathname === "/api/search.json")
    return govSearch(
      /student|visa/i.test(url.searchParams.get("q") ?? "")
        ? [{ title: "Student visa", link: "/student-visa", description: "Short description." }]
        : [],
    );
  if (url.pathname === "/api/content/student-visa")
    return Response.json({
      details: {
        parts: [
          { body: "<p>You can work up to 20 hours a week during term &amp; full-time in vacations.</p>" },
          { body: "<script>ignored()</script><p>Fees: &pound;524.</p>" },
        ],
      },
    });
  return new Response("not found", { status: 404 });
}

test("searches Wikipedia and GOV.UK and returns clean, labelled excerpts", async () => {
  const requests = network(standardSources);
  const sources = await searchWeb(["Leicester", "Student visa"], AbortSignal.timeout(5000));
  assert.deepEqual(
    sources.map((source) => [source.site, source.title, source.url]),
    [
      ["Wikipedia", "Leicester", "https://en.wikipedia.org/wiki/Leicester"],
      ["GOV.UK", "Student visa", "https://www.gov.uk/student-visa"],
    ],
  );
  assert.equal(
    sources[1].text,
    "You can work up to 20 hours a week during term & full-time in vacations. Fees: £524.",
  );
  assert.deepEqual(Object.keys(sources[0]).sort(), ["site", "text", "title", "url"]);
  for (const request of requests) {
    assert.equal(request.init?.cache, "no-store");
    const agent = String((request.init?.headers as Record<string, string>)["User-Agent"]);
    assert.equal(agent, "RelayInterviewHelper/1.0 (personal, non-commercial study tool)");
  }
  const formatted = formatWebResults(sources);
  assert.match(formatted, /^\[1\] Wikipedia: Leicester \(https:\/\/en\.wikipedia\.org\/wiki\/Leicester\)\nLeicester is a city/);
  assert.match(formatted, /\n\n\[2\] GOV\.UK: Student visa/);
});

test("an optional contact is added to the User-Agent, as Wikipedia asks", async () => {
  process.env.WEB_SEARCH_CONTACT = "owner@example.com";
  const requests = network(standardSources);
  await searchWeb(["Leicester"], AbortSignal.timeout(5000));
  for (const request of requests)
    assert.equal(
      (request.init?.headers as Record<string, string>)["User-Agent"],
      "RelayInterviewHelper/1.0 (personal, non-commercial study tool; owner@example.com)",
    );
});

test("a failing source is skipped while the other still answers", async () => {
  network((url) =>
    url.hostname === "en.wikipedia.org"
      ? new Response("rate limited", { status: 429 })
      : standardSources(url),
  );
  const sources = await searchWeb(["Student visa"], AbortSignal.timeout(5000));
  assert.deepEqual(sources.map((source) => source.site), ["GOV.UK"]);
});

test("a slow source is cut off at the time limit", async () => {
  network((url, init) =>
    url.hostname === "en.wikipedia.org"
      ? new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        )
      : standardSources(url),
  );
  const started = performance.now();
  const sources = await searchWeb(["Student visa"], AbortSignal.timeout(5000), { timeoutMs: 200 });
  assert.ok(performance.now() - started < 1500);
  assert.deepEqual(sources.map((source) => source.site), ["GOV.UK"]);
});

test("long pages are clipped at a sentence and duplicates removed", async () => {
  const sentence = "This sentence is about a city and its long history. ";
  network((url) => {
    if (url.hostname === "en.wikipedia.org")
      return isWikiSearch(url)
        ? wikiSearch(["Long page"])
        : wikiPages({ "Long page": sentence.repeat(100) });
    return govSearch([]);
  });
  const sources = await searchWeb(["Long page", "long page", "LONG PAGE"], AbortSignal.timeout(5000));
  assert.equal(sources.length, 1, "the same page found by three queries appears once");
  assert.ok(sources[0].text.length <= 3000);
  assert.ok(sources[0].text.endsWith("history."), "ends on a full sentence");
});

test("a guide keeps a short overview first, then the sections that match the question", async () => {
  const overview = "Most people need to pay the immigration health surcharge. ".repeat(40);
  network((url) => {
    if (url.hostname === "en.wikipedia.org") return isWikiSearch(url) ? wikiSearch([]) : wikiPages({});
    if (url.pathname === "/api/search.json")
      return govSearch([
        {
          title: "Pay for UK healthcare as part of your immigration application",
          link: "/healthcare-immigration-application",
          description: "How and when to pay the immigration health surcharge (IHS).",
        },
      ]);
    return Response.json({
      details: {
        parts: [
          { title: "Overview", body: `<p>${overview}</p>` },
          { title: "Who needs to pay", body: "<p>You usually need to pay if you apply for a visa.</p>" },
          { title: "Refunds", body: "<p>You may get a refund if your application is refused.</p>" },
          { title: "How much you have to pay", body: "<p>You'll pay &pound;776 per year for a student visa.</p>" },
        ],
      },
    });
  });
  const [guide] = await searchWeb(["Immigration Health Surcharge"], AbortSignal.timeout(5000), {
    question: "How much is the Immigration Health Surcharge for students?",
  });
  assert.ok(guide.text.startsWith("Overview: Most people need to pay"));
  // The overview is shortened so the matching section is not cut off.
  assert.ok(guide.text.indexOf("How much you have to pay: You'll pay £776 per year") < 800);
  assert.ok(guide.text.indexOf("How much you have to pay") < guide.text.indexOf("Who needs to pay"));
});

test("GOV.UK's top two results are used, plus the best match further down", async () => {
  const requests = network((url) => {
    if (url.hostname === "en.wikipedia.org") return isWikiSearch(url) ? wikiSearch([]) : wikiPages({});
    if (url.pathname === "/api/search.json")
      return govSearch([
        { title: "How to apply for a visa to come to the UK", link: "/apply-to-come-to-the-uk" },
        { title: "Skilled Worker visa", link: "/skilled-worker-visa" },
        { title: "Universal Credit", link: "/universal-credit" },
        { title: "Graduate visa", link: "/graduate-visa" },
        { title: "Pay for UK healthcare", link: "/healthcare-immigration-application", description: "The immigration health surcharge (IHS) for a visa." },
      ]);
    return Response.json({ details: { body: `<p>Page ${url.pathname} about the visa and the health surcharge.</p>` } });
  });
  await searchWeb(["visa health surcharge"], AbortSignal.timeout(5000));
  const fetched = requests
    .filter((request) => request.url.pathname.startsWith("/api/content/"))
    .map((request) => request.url.pathname.replace("/api/content", ""));
  // "Universal Credit" shares no search words and is never fetched.
  assert.deepEqual(fetched.sort(), ["/apply-to-come-to-the-uk", "/healthcare-immigration-application", "/skilled-worker-visa"]);
});

test("each site's top results come first, the question breaks ties, and unrelated pages are dropped", async () => {
  network((url) => {
    if (url.hostname === "en.wikipedia.org")
      return isWikiSearch(url)
        ? wikiSearch(["Leicester", "Boeing 747"])
        : wikiPages({
            "Boeing 747": "The Boeing 747 is a large aircraft.",
            Leicester: "Leicester is a city in England with a population of 383,116.",
          });
    if (url.pathname === "/api/search.json")
      return govSearch([
        { title: "Leicester Prison", link: "/leicester-prison" },
        { title: "Leicester Probation Office", link: "/leicester-probation" },
      ]);
    return Response.json({ details: { body: `<p>Visiting ${url.pathname} in Leicester.</p>` } });
  });
  const sources = await searchWeb(["Leicester"], AbortSignal.timeout(5000), {
    question: "What is the population of Leicester?",
  });
  assert.deepEqual(
    sources.map((source) => source.title),
    ["Leicester", "Leicester Prison", "Leicester Probation Office"],
  );
});

test("HTML is converted to plain text without scripts or tags", () => {
  assert.equal(
    htmlToText('<style>p{}</style><h2>Fees</h2><p>It&#39;s &quot;£776&quot; a&nbsp;year</p>'),
    'Fees It\'s "£776" a year',
  );
});
