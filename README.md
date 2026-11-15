# Relay — private live answers

Relay connects one question sender and one answer viewer. Answers come from one administrator-written **memory** (a private text). A general fact the memory does not cover (for example a UK visa rule or fee) is looked up on Wikipedia and GOV.UK and clearly marked on the viewer as from the internet. Any other question about the applicant that the memory does not cover (for example how they used advice from teachers, hobbies, or a hypothetical situation) gets a general, made-up answer, marked as made up. A fact about the applicant that would be in their documents or records and is not in the memory (for example relatives in the UK or a test score) gets an honest reply that never invents the fact, marked in red. “Not in memory” is shown only when the memory is empty. The sender receives statuses only. The viewer sees the answer as it is generated, in a single horizontal scrolling pass.

See [memory answering](docs/memory-answering.md) for the current design, measured speed and limitations.

See [the final implementation report](docs/final-implementation-report.md) for actual verification results and limitations. The original [Step 1 report](docs/step-1-report.md) is historical.

## Run locally

Verified with Node.js 24.16.0 and npm 11.13.0 on Windows.

```powershell
Set-Location 'C:\Users\USER\Desktop\ukvi'
npm ci
npm run dev
```

Open **http://localhost:3000**. Keep the terminal running. `npm ci` is only needed when installing or restoring dependencies. Both `.env` and `.env.local` are loaded by Next.js; `.env.local` takes precedence. Restart after changing server configuration. Never commit either file.

For a production build on localhost:

```powershell
npm run build
npm run start
```

## Environment

Use `.env.example` as the variable reference; do not overwrite an existing configured file.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Modern `sb_publishable_` key; no privileged browser access |
| `SUPABASE_SECRET_KEY` | Modern `sb_secret_` key, server only |
| `GEMINI_API_KEY` | Server-only Gemini API key |
| `ADMIN_PASSWORD` | Administrator password you choose |
| `ADMIN_SESSION_SECRET` | Independent random secret, at least 32 characters; signs admin cookies |
| `GEMINI_MODEL` | Defaults to `gemini-3.5-flash-lite`; live matching and generation verified |
| `GEMINI_FALLBACK_MODEL` | Comma-separated backup models in order; defaults to `gemini-3.6-flash` for the default primary, otherwise `gemini-3.5-flash-lite`. Empty disables backups. Used immediately after a transient error or a used-up quota, in parallel when the main model sends no text within 2.5 seconds (at most three such requests), to finish an answer that broke off (up to three continuations), and as a second opinion when a web answer is refused. `gemini-3.1-flash-lite` is not a default: in tests it added facts that were not in the memory. |
| `GEMINI_THINKING_LEVEL` | `minimal` (default), `low` or `medium` for Gemini 3 models. Live tests: `low` delayed first words 2–4× and did not improve answers |
| `GEMINI_REQUESTS_PER_MINUTE` | Default 20 Gemini requests/minute (a hedged, rescued or web-backed answer uses two to five); lower to your provider quota |
| `WEB_SEARCH_CONTACT` | Optional email or URL sent to Wikipedia with web lookups. Wikipedia asks API clients for contact details and rate-limits anonymous clients sooner. Leave empty to send none |
| `APP_ORIGIN` | Optional exact browser origin, including scheme and port; configure explicitly behind a proxy |
| `TRUST_PROXY_HEADERS` | Default false; enable only behind a trusted proxy that removes spoofed forwarding headers |

Generate a new signing secret for a new installation, then put its output in your private environment file:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

This workspace already has a generated signing secret. Do not rotate it unless you intend to invalidate existing admin sign-ins. No secret belongs in a `NEXT_PUBLIC_` variable. There is no API for changing provider keys or model settings from the browser.

The app does not enable billing, switch to a paid provider, or assume unlimited free quota. The configured model and key passed live tests. Account limits can change. Authentication failures are not retried; when a model reports its quota used up (HTTP 429), it is skipped for 30 minutes (daily quota) or 60 seconds (per-minute quota) and the next model answers. With an empty memory every answer is “Not in memory” and no Gemini request is made. Reduce the local request budget if necessary; it is not a substitute for the provider's token/daily limits.

## Supabase setup

For a new database, manually run these files in the Dashboard SQL Editor, in this exact order:

1. `supabase/migrations/20261103192919_relay_database_foundation.sql`
2. `supabase/migrations/20261103192921_private_reference_storage.sql`
3. `supabase/migrations/20261103195630_relay_application.sql`
4. `supabase/migrations/20261103195632_session_expiration_schedule.sql`

**All four have already been applied to this workspace's project. Do not rerun them.** No additional migration is required. They create private tables, server-only RPCs, vector(768) indexes, a private `reference-documents` bucket, and the minute-based expiration job.

Read-only checks are in `supabase/verification/foundation.sql` and `supabase/verification/application.sql`. User-supplied Dashboard results confirm the permissions, dimensions, active schedule, and successful recent cron runs. Live application tests also exercised the deployed schema. `/api/health/supabase` returns a safe connectivity status.

Dashboard SQL execution does not record CLI migration history. The earlier verification found no migration-history table, and the current CLI login lacked this project's permissions. Before any future CLI `db push`, an authorized owner must log into the correct account, link the correct project, compare the schema with these files, and repair migration history to mark the four versions as already applied. Do not blindly push them again. No migration-history repair or remote DDL was performed by this implementation.

## Use two laptops

Run one server on Laptop A. Connect both laptops to the same trusted local network:

```powershell
npm run dev -- --hostname 0.0.0.0
```

Use Laptop A's LAN IPv4 address on **both** browsers, for example `http://192.168.0.229:3000` if that is still its address. Find the current address with `ipconfig`. The development server automatically allows Laptop A's current LAN addresses (read at start-up in `next.config.ts`); after joining a different Wi-Fi network, restart `npm run dev` or other devices will stay on “Checking session availability…”. Allow Node through Windows Firewall for your private network if Windows asks. Do not use `localhost` on Laptop B: that would refer to Laptop B itself. Avoid switching between localhost and the LAN address mid-session, because cookies belong to their hostname.

Plain HTTP over a trusted LAN is for development testing only. Production cookies require HTTPS except on browser-trusted localhost. A public deployment needs HTTPS, the correct `APP_ORIGIN`, protected admin access, and hosting that supports the processing/stream durations below. Fullscreen availability on LAN HTTP depends on the browser; the normal viewer remains usable.

1. Person A opens `/`, chooses **Create Session**, and privately shares the code shown on `/sender`.
2. Person B opens the same server address, enters the code, and chooses **Join Session**.
3. A types a question and presses **20–30 sec**, **40 sec** or **60–70 sec** (keyboard: Ctrl+Enter / Command+Enter sends 20–30 sec, add Alt / Option for 40 sec, or Shift for 60–70 sec). More questions can be submitted while processing continues. Only the newest eligible result can publish.
4. B's answer moves right to left once. The speed slider (default 260 px/s, remembered per browser) changes velocity without resetting position. A new answer replaces the current one; a completed pass clears. There are no pause, resume, or replay controls.
5. Reopen the sender/viewer route in the original browser to reconnect. Keep its cookies. A viewer reconnect starts the latest available answer from the beginning once.
6. Both participants choose **Quit session** to close immediately. After one participant quits the session cannot continue: anyone can press **End session now** on the home page to close it at once. The administrator can also end any session from `/admin`. Closing a tab is a disconnection, not an explicit quit.

## Knowledge management

Open `/admin` and sign in with your configured password. Administration is separate from participation; reading and saving the memory require server-side admin authorization.

The page has one **Memory** text box (up to 100,000 characters). Write the facts answers may use: background, course, university, finances, accommodation, plans. It is stored privately in Supabase Storage (`reference-documents/relay-memory/memory.txt`); no migration is needed. A saved change applies to the next question. Shorter memory gives faster answers.

Prepared Q&A, file imports, reference-document uploads and embeddings were removed in the memory redesign. Their database tables still exist but are unused and empty; no migration was applied.

## How answers are produced

1. The memory is kept in a server-side cache, refreshed in the background and immediately after it is saved, so a question never waits for it. An empty memory answers “Not in memory” without calling Gemini.
2. Otherwise one streamed Gemini request receives the rules, the whole memory and the question. The answer is written only from the memory: first person, pre-CAS interview style, at the length A chose: 45–65 words (20–30 seconds), 82–95 words (about 40 seconds) or 135–155 words (60–70 seconds), sized for reading the ticker at 260 px/s (its 42 px text measures about 114.6 px per word). The AI ranks the memory's facts by importance to the question and keeps the most important ones that fit the length, speaking in a relaxed, friendly way in its own words (contractions, no numbered points, no copied sentences), and finishes naturally. Two automatic safety nets apply: overstatement words (definitely, easily, perfectly, absolutely, totally) are removed before the viewer sees them, and an answer that ends clearly short of its length is extended with the next most important facts; numbers are written in digits; no conclusions the memory does not state (for example that funds are “sufficient”). With nothing relevant in memory the answer is exactly “Not in memory”.
3. **Web lookup** for general facts. When the memory cannot answer, or covers only part of a general-fact question and its answer comes out clearly short, a small separate request (which never sees the memory) decides whether the question asks for a checkable fact about the applicant (height, age, family, relatives, travel or visa history, documents, grades, dates, money, names, jobs), a soft question about how they think, work or deal with things (habits, how they used advice, strengths and weaknesses, pressure, teamwork, reasons such as for a study gap), or a general fact anyone could look up. Facts that would be in the applicant's records are never searched or made up: they get an honest reply (it says the applicant would rather give the exact detail than guess, then gives relevant true facts from the memory), shown in red with the badge “This fact is missing from your memory — say the real answer yourself”. A general fact the web search cannot answer gets the same honest reply. When unsure, the lookup step chooses a made-up answer. Soft questions get a believable, general answer that fits the memory, never with invented names, places, dates, numbers, grades, awards or specific events; it is shown in blue with the badge “Made up — not from your memory” (or only the added part, after a short memory answer). For a general fact, Wikipedia and GOV.UK are searched (free public APIs, no key; Gemini's own Google Search is not available on the free tier), the best-matching pages are kept, and the answer is written from what they clearly state, with the memory still the only source about the applicant (the memory wins any disagreement). If the sources do not answer it, the reply is “Not in memory”. The viewer marks internet facts in amber with a badge: the whole answer (“From the internet — not from your memory”) or only the part added after a memory answer. Web answers take about 5–13 seconds to start, depending on Gemini's speed.
4. The request starts as soon as the question arrives, in parallel with saving it, and text is pushed to the viewer as it is generated. A durable database lease and latest-question check still control the final publication; late results cannot overwrite a newer question. The answer is stored only in transient `session_answer_state`, which is deleted when the session terminates.

AI failures are status codes for A, never error tickers for B. Quota/authentication failures are not retried; temporary errors switch to the next backup model immediately (at most three requests). If an answer breaks off after text has reached the viewer (for example Gemini's mid-stream “high demand” error), the shown words stay and the rest is requested as a continuation from exactly where it stopped, rotating models, up to three times; only if all fail does the partial text finish its pass while A sees the error. Requests and workers have deadlines.

## Reliability and deployment limits

- HTTP-only SameSite=Strict participant cookies hold random credentials; only hashes are in the database. Admin cookies are separately signed and expire after eight hours. Browser clients cannot access application tables or privileged RPCs directly.
- SSE is authenticated and server mediated. The viewer falls back to polling when streaming drops. Heartbeats every 15 seconds drive presence; a connection becomes stale after 45 seconds. Ten minutes with both disconnected expires the session. Cron runs every minute, and access/create operations also reconcile expiration atomically.
- Question workers run using Next.js `after`, with a 120-second route allowance and a 60-second answer deadline; database leases last 120 seconds. Live text push works within one server process (the normal `npm run dev`/`npm run start` setup); with several processes, viewers still receive the published answer by polling. Heartbeats recover abandoned work, with at most three claims. SSE routes allow up to 300 seconds. Use a persistent Node server or hosting with suitable limits. A static export cannot run this app.
- Rate limits persist in Supabase. Without trusted proxy headers, create/join/admin-login limits share a fallback bucket; this is suitable for the current single-session local test but can throttle multiple people behind the same deployment.
- Only one credential slot per role is supported. Clearing cookies loses reconnection ownership; the private session code cannot replace an occupied role. Multiple tabs sharing one cookie are not independent participants.
- Questions and terminated session metadata are retained; answer text is deleted at termination. Establish an appropriate retention/cleanup policy before public deployment.
- Minimal administrator authentication and bounded parsers are implemented. A dedicated admin-panel/authentication audit, hostile-file fuzzing, production deployment review, and testing on two physical laptops were deliberately not part of this run.

## Validation commands

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:server-boundary
npm run verify:client-secrets
npm audit --omit=dev --audit-level=moderate
```

`npm test` uses isolated PGlite databases and mocked provider seams; it never modifies the remote project. Live checks in this run separately used the configured Supabase/Gemini services and independent Chrome contexts; only uniquely identified fixtures were created and removed. Detailed results are in the final report. Local verification harnesses/results are under ignored `.verification/`.

## Main source areas

- `src/app/api/session`, `questions`, `viewer`: authenticated participant APIs and streaming.
- `src/lib/server`: cookies, input validation, safe errors, role projections, persisted limits.
- `src/lib/ai`: streamed/hedged provider calls, memory answer engine, durable worker coordination.
- `src/lib/knowledge`: memory storage and cache.
- `src/app/api/admin` and `src/components/admin-workspace.tsx`: protected knowledge workflows.
- `src/components/*-workspace.tsx` and `answer-ticker.tsx`: working pages and single-pass display.
- `supabase/migrations`, `supabase/verification`, `tests`: schema, read-only checks, deterministic regression tests.
