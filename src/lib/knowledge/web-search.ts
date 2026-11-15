import "server-only";

/**
 * Free web lookups for general facts the memory does not contain.
 * Gemini's own Google Search is not available on the free tier, so the app
 * searches two free, reliable sources itself (no account or key needed):
 * Wikipedia for general facts, and GOV.UK for official UK rules and fees.
 */
export type WebSource = {
  site: "Wikipedia" | "GOV.UK";
  title: string;
  url: string;
  text: string;
};

// Wikipedia asks API clients to give contact details and limits anonymous ones
// sooner. WEB_SEARCH_CONTACT (an email or URL, optional) is added when set.
function userAgent() {
  const contact = process.env.WEB_SEARCH_CONTACT?.trim();
  return `RelayInterviewHelper/1.0 (personal, non-commercial study tool${contact ? `; ${contact}` : ""})`;
}
const MAX_SOURCE_CHARS = 3_000;
const MAX_TOTAL_CHARS = 12_000;
// Guide pages: a short overview, then the sections that best match the question.
const OVERVIEW_CHARS = 700;
const SECTION_CHARS = 1_400;
const MAX_SOURCES = 4;
export const WEB_SEARCH_TIMEOUT_MS = 5_000;

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/json" },
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function clip(text: string, max = MAX_SOURCE_CHARS) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  // End on a sentence where possible, never mid-word.
  const sentence = cut.lastIndexOf(". ");
  return sentence > max / 2 ? cut.slice(0, sentence + 1) : cut.replace(/\s+\S*$/, "");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&pound;": "£",
};
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|pound);/g, (entity) => ENTITIES[entity] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(
  "a about an and any are can could do does explain for from has have how in is it its know of on or rule rules tell that the their there this to uk was what when where which who why will with would you your".split(" "),
);
function keywords(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => !STOP_WORDS.has(word))
      .map((word) => word.replace(/ies$/, "y").replace(/s$/, ""))
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}
/** True when a page word is the wanted word or a longer form of it (health → healthcare). */
function contains(words: Set<string>, wanted: string) {
  if (words.has(wanted)) return true;
  if (wanted.length < 4) return false;
  for (const word of words) if (word.startsWith(wanted)) return true;
  return false;
}
/** How well a title and text match the wanted words (title words count most). */
function relevance(wanted: Set<string>, title: string, text: string) {
  const inTitle = keywords(title);
  const inText = keywords(text);
  let score = 0;
  for (const word of wanted) {
    if (contains(inTitle, word)) score += 3;
    if (contains(inText, word)) score += 1;
  }
  return score;
}

/** A page found by a search, with its position in that site's results (0 = top). */
type Found = WebSource & { rank: number };

type WikiSearch = { query?: { search?: { title?: string }[] } };
type WikiPages = { query?: { pages?: Record<string, { title?: string; extract?: string }> } };
async function wikipedia(query: string, signal: AbortSignal): Promise<Found[]> {
  const base = "https://en.wikipedia.org/w/api.php?format=json&action=query";
  const search = (await getJson(
    `${base}&list=search&srlimit=2&srsearch=${encodeURIComponent(query)}`,
    signal,
  )) as WikiSearch;
  const titles = (search.query?.search ?? [])
    .map((result) => result.title)
    .filter((title): title is string => Boolean(title));
  if (!titles.length) return [];
  const pages = (await getJson(
    `${base}&prop=extracts&exintro=1&explaintext=1&titles=${titles.map(encodeURIComponent).join("|")}`,
    signal,
  )) as WikiPages;
  // Pages come back keyed by page id; the search order is kept as the rank.
  return Object.values(pages.query?.pages ?? {})
    .filter((page) => page.title && page.extract?.trim())
    .map((page) => {
      const rank = titles.indexOf(page.title!);
      return {
        site: "Wikipedia" as const,
        title: page.title!,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title!.replace(/ /g, "_"))}`,
        text: clip(page.extract!),
        rank: rank < 0 ? titles.length : rank,
      };
    });
}

type GovPart = { title?: string; body?: string };
type GovSearch = { results?: { title?: string; link?: string; description?: string }[] };
type GovContent = { details?: { body?: string; parts?: GovPart[] } };
/**
 * GOV.UK guides are split into sections ("Overview", "How much you have to
 * pay", ...). The overview stays first (it says what the thing is); the other
 * sections follow in order of how well they match the question, so the
 * answer is not cut off by the size limit.
 */
function guideText(details: GovContent["details"], asked: Set<string>) {
  if (!details) return "";
  if (details.body) return htmlToText(details.body);
  const parts = (details.parts ?? [])
    .filter((part) => part.body)
    .map((part, index) => {
      const text = clip(htmlToText(part.body!), index === 0 ? OVERVIEW_CHARS : SECTION_CHARS);
      return {
        text: part.title ? `${part.title}: ${text}` : text,
        score: index === 0 ? Infinity : relevance(asked, part.title ?? "", text),
        index,
      };
    });
  return parts
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((part) => part.text)
    .join(" ");
}
async function govuk(query: string, signal: AbortSignal, asked: Set<string>): Promise<Found[]> {
  // GOV.UK's own order is good for short topic names but weak for longer
  // queries (in tests the right guide was sometimes sixth). So fetch its top
  // two plus the best-matching other result.
  const search = (await getJson(
    `https://www.gov.uk/api/search.json?count=8&q=${encodeURIComponent(query)}`,
    signal,
  )) as GovSearch;
  const wanted = keywords(query);
  const results = (search.results ?? [])
    .filter((result) => result.title && result.link?.startsWith("/"))
    .map((result) => ({ result, score: relevance(wanted, result.title!, result.description ?? "") }))
    .filter((item) => item.score > 0);
  const [best] = results.slice(2).sort((a, b) => b.score - a.score);
  const chosen = [...results.slice(0, 2), ...(best ? [best] : [])].map((item) => item.result);
  return Promise.all(
    chosen.map(async (result, rank) => {
      let text = result.description ?? "";
      try {
        const content = (await getJson(
          `https://www.gov.uk/api/content${result.link}`,
          signal,
        )) as GovContent;
        text = guideText(content.details, asked) || text;
      } catch {
        /* Keep the search description. */
      }
      return {
        site: "GOV.UK" as const,
        title: result.title!,
        url: `https://www.gov.uk${result.link}`,
        text: clip(text),
        rank,
      };
    }),
  );
}

/**
 * Orders what was found and drops clearly unrelated pages. In live tests the
 * model gave up when off-topic pages came first (aircraft pages for a visa
 * question, refund pages for a fee question), even with the answer further
 * down. The sites' own order is the best signal for short topic names, so
 * each site's top results come first; among those, the page that matches
 * more of the question (for example "population") goes first. Pages that
 * share few of the search words are dropped.
 */
function rankSources(found: Found[], queries: string[], question: string): WebSource[] {
  const wanted = keywords(queries.join(" "));
  const asked = keywords(question);
  const scored = found.map((source, index) => ({
    source,
    index,
    score: relevance(wanted, source.title, source.text),
    fit: relevance(asked, source.title, source.text),
  }));
  const best = Math.max(0, ...scored.map((item) => item.score));
  return scored
    .filter((item) => !wanted.size || (item.score > 0 && item.score >= best * 0.4))
    .sort((a, b) => a.source.rank - b.source.rank || b.fit - a.fit || a.index - b.index)
    .slice(0, MAX_SOURCES)
    .map(({ source }) => ({ site: source.site, title: source.title, url: source.url, text: source.text }));
}

/**
 * Searches both sites for each query in parallel. Failed or slow requests
 * are skipped; results are de-duplicated, ordered for relevance and bounded.
 */
export async function searchWeb(
  queries: string[],
  signal: AbortSignal,
  { question = "", timeoutMs = WEB_SEARCH_TIMEOUT_MS }: { question?: string; timeoutMs?: number } = {},
): Promise<WebSource[]> {
  const limited = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  // Guide sections are chosen by what was asked (for example "how much").
  const asked = keywords(question || queries.join(" "));
  const settled = await Promise.allSettled(
    queries.flatMap((query) => [wikipedia(query, limited), govuk(query, limited, asked)]),
  );
  signal.throwIfAborted();
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const source of outcome.value) {
      if (!source.text || seen.has(source.url)) continue;
      seen.add(source.url);
      found.push(source);
    }
  }
  const sources: WebSource[] = [];
  let total = 0;
  for (const source of rankSources(found, queries, question)) {
    if (total + source.text.length > MAX_TOTAL_CHARS) continue;
    sources.push(source);
    total += source.text.length;
  }
  return sources;
}

/** Formats search results for the model, as clearly marked untrusted data. */
export function formatWebResults(sources: WebSource[]) {
  return sources
    .map((source, index) => `[${index + 1}] ${source.site}: ${source.title} (${source.url})\n${source.text}`)
    .join("\n\n");
}
