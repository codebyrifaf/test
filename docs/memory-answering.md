# Memory answering — 7 November 2026

Relay answers only from one administrator-written **memory**. The earlier search → match → reference-generation pipeline, reference-document uploads, embeddings, prepared Q&A and file imports are removed. No SQL migration was needed or applied; the unused tables remain, empty.

## Behaviour

- **Memory**: the only control on `/admin` — one text box (up to 100,000 characters), stored privately at `reference-documents/relay-memory/memory.txt`. A save applies to the next question.
- **Answers**: first person, as the applicant in a UK university pre-CAS interview. The sender chooses the length per question: **20–30 sec** (45–65 words), **40 sec** (82–95 words) or **60–70 sec** (135–155 words), sized for reading the ticker at 260 px/s (measured 114.6 px per word at the ticker's 42 px text; the viewer's speed defaults to 260 px/s). The AI ranks the memory's facts by importance to the question and keeps the most important ones that fit, with the direct answer first and a short concluding sentence at the end. Facts come only from the memory; no conclusions the memory does not state (for example that funds are “sufficient”); numbers in digits. If the memory has nothing relevant — or is empty — the viewer sees exactly **Not in memory** (an empty memory needs no Gemini request).
- The sender/viewer/session flow is unchanged.

## Data erased on 7 November 2026 (at the owner's request)

- All 94 prepared Q&A rows (and their 94 alternative-phrasing rows) were deleted. A local backup was written first to `.verification/backup-prepared-qa-2026-11-07.json` (ignored by version control). Delete that file if the data is no longer wanted.
- No memory had been saved, so there was nothing to erase there. No session was live and no answer was stored.

## Speed design

1. The memory is cached in the server process and refreshed in the background, so questions do not wait for storage.
2. Gemini starts the moment a question arrives, in parallel with saving it, for a sender the database authorized within the last 30 seconds.
3. The answer is streamed; text is pushed to the viewer as it is generated and the ticker starts with the first words. The database lease and latest-question check still decide final publication.
4. The request budget check runs alongside the Gemini request instead of before it.
5. Model failover: the chain is 3.5 Flash-Lite, then 3.6 Flash (both on this key's free tier; billing is off, so no charges are possible). 3.1 Flash-Lite was removed from the defaults on 13 November because it added facts that were not in the memory. A 5xx/network failure switches to the next model immediately. If the main model sends no text within 2.5 seconds, the backup starts in parallel and the first to send text wins (at most three requests).
6. Broken-answer rescue: if Gemini's stream fails after text has appeared (its “high demand” error can arrive mid-answer), the shown words stay and the rest is requested as a continuation from exactly where it stopped, rotating models, up to three times. The viewer reads far slower than Gemini writes, so the gap is normally invisible. Only a normal finish signal from Gemini counts as a complete answer.

## Measured results (live Supabase and Gemini, production build)

| Check | Result |
| --- | --- |
| Question accepted by the server | 0.3–0.4 s |
| First words on the viewer | 1.5–2.8 s typical; 3.9–4.8 s when Gemini's primary model was slow (hedge engaged) |
| Real browser (Chrome, two contexts), memory-only build | Admin memory save/reload; no prepared/import/document controls; old admin routes return 404; ticker moves, text grows while streaming, single pass and clear, no replay; “Not in memory” shown; sender never sees answers; delivery confirmed; session closed |

Latency is dominated by Gemini's own response time, which varied between runs on the same day. The application cannot guarantee 2–3 seconds when the provider is slow.

## Verification

`npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (79 tests: 7 Supabase, 48 application, 12 foundation database, 12 session database), `verify:client-secrets` (17 assets) and `verify:server-boundary` passed. Live harnesses: `.verification/verify-memory-e2e.mjs`, `verify-memory-browser.mjs`; results in `.verification/memory-*-results.json`. Each run used a synthetic memory, removed it afterwards, and quit its own session.

## Limitations

- If an answer breaks off after text has appeared, the partial text finishes its pass and the sender sees an error; it is not restarted.
- Live text push requires the worker and viewer stream to run in the same server process (true for `npm run dev`/`npm run start`). Otherwise viewers receive the published answer by polling.
- A larger memory sends more tokens per question: slower answers and more provider quota use.

## Files

Changed: `src/lib/ai/provider.ts`, `provider-request.ts`, `pipeline.ts`, `worker.ts`; `src/lib/server/sessions.ts`, `processing-diagnostics.ts`; `src/app/api/questions`, `session/sender`, `session/quit`, `viewer/events` routes; `src/app/admin/page.tsx`, `src/app/layout.tsx`; `src/components/admin-workspace.tsx`, `viewer-workspace.tsx`, `answer-ticker.tsx`; tests `pipeline`, `provider-failover`, `provider-request`; `scripts/verify-session-availability.mjs`; `next.config.ts`, `package.json` (file-parsing packages uninstalled), `README.md`, `.env.example`.

New: `src/lib/knowledge/memory.ts`, `src/lib/server/live-channel.ts`, `src/app/api/admin/memory/route.ts`.

Removed (copies kept in `.verification/removed-before-memory-redesign/`): admin `documents`, `index`, `qa` and `import` routes; `src/lib/knowledge/extract.ts`, `store.ts`; `tests/extraction.test.ts`, `file-fixtures.ts`; `scripts/verify-question-processing.mjs`.

## Choosing what to say — 10 November 2026

The instructions now make the model work out what the interviewer is checking, rank the memory's facts by importance to the question, keep the most important ones that fit the chosen length (20–30 s, 40 s or 60–70 s), put the direct answer first and end with a short concluding sentence.

Live comparison on the owner's 33,842-character memory, 6 questions × 3 lengths per version (`.verification/answer-quality-report.md`):

| Version | Result |
| --- | --- |
| Old instructions, minimal thinking | Ignored a 20–30 s length once (94 words, copied a stored answer); invented "unconditional" offer, "registered" company, return "immediately" |
| **New instructions, minimal thinking (adopted)** | Kept the lengths, put the most important reason first ("Most importantly…"), ended with conclusions; no invented facts found |
| New instructions, low thinking | First words 2–4× slower (median 8 s, up to 22 s) and invented "born and raised" |

Gemini was overloaded during these tests (first words 1.3–11 s for every version; 503 "high demand" errors at the start and mid-answer). With the 3.6 Flash backup, the 2.5-second hedge and broken-answer rescue, 18 of 18 live answers completed (6 of 18 failed before). Forced mid-answer breaks were continued seamlessly, including a break inside a number ("155" + ",000 taka").

The key's quota errors name free-tier metrics, so billing is off and no charges are possible. Google's pricing page notes that free-tier content can be used to improve Google's products.

## Speaking style — 10 November 2026

The owner chose a relaxed, friendly speaking style (over a more formal one) after comparing samples. The instructions now ask for the model's own words, contractions, no numbered points (First, Second...), no hype or certainty words, and every fact and number exactly as the memory states it, with an interview-style example of essay-like versus spoken answers. A short style reminder is repeated next to each question.

Flash-Lite did not follow the word count or the word bans reliably in this style (40-second answers came out at about 45 to 75 words; "definitely" kept appearing), so two deterministic safety nets were added:

- Overstatement words (definitely, easily, perfectly, absolutely, totally) are removed from the text before the viewer sees it. A trailing unfinished word is held back until complete, so shown text never changes.
- An answer below 85% of its minimum length gets one extension request for the next most important facts, appended to what is already shown; if that request fails, the complete original answer is kept.

When a model reports its free daily quota is used up (HTTP 429), it is skipped for 30 minutes and the next model answers. Testing on 10 November used up 3.6 Flash's free daily quota; it resets at midnight Pacific time.

## Web lookup for general facts — 13 November 2026

At the owner's request, a general fact the memory does not cover is now looked up on the internet instead of answering “Not in memory”. Agreed rules: personal questions the memory does not cover stay “Not in memory”; internet facts are marked on the viewer; memory and internet facts are combined. For safety, a question the memory answers fully is answered from the memory only.

How it works (`src/lib/ai/pipeline.ts`, `src/lib/knowledge/web-search.ts`):

1. The memory answer runs exactly as before, with the memory-only rules. A “Not in memory” reply is held back from the viewer.
2. If the memory gives “Not in memory”, or its answer is still clearly short after the usual extension, a small separate request (`LOOKUP_RULES`, which never sees the memory) replies `PERSONAL` or `SEARCH:` with one or two short topic names (for example “Immigration Health Surcharge”, “Graduate visa”). When unsure it chooses `PERSONAL`; queries never contain the applicant's details.
3. Wikipedia (search, then page introductions) and GOV.UK (search, then the guide's content) are queried in parallel with a 5-second limit. Gemini's Google Search grounding is not available on the free tier (it returned 429 at once), so the app uses these free public APIs, which need no key.
4. Choosing pages: GOV.UK's top two results plus the best-matching one further down; each site's top results first, with the page that matches more of the question breaking ties (for example “population”); pages sharing few of the search words are dropped; at most 4 pages. GOV.UK guides keep a short overview first, then the sections that best match the question (for example “How much you have to pay”), so the answer is not cut off by the size limit (3,000 characters per page, 12,000 in total).
5. The answer is written with separate web rules: facts only as the web results clearly state them, the memory as the only source about the applicant, the memory wins any disagreement, the figures for a Student visa applicant when they differ by group, no mention of searching or sources, and “Not in memory” only if no result answers. The results are marked as untrusted data.
6. In live tests Flash-Lite sometimes refused although a matching result was given, and answered correctly on another try, so a refusal gets one second opinion with the backup model first.
7. A whole web answer is published with a `[web] ` prefix; facts added after a memory answer are joined with `[web] ` in the middle. The viewer removes the marker, shows a badge, and colours the internet part amber.

Also changed: an extension may now reply “Not in memory” instead of inventing words to reach the length, and the per-question reminder says to reach the length “with real facts, never with filler sentences or promises”. Both were prompted by a live answer that padded a one-line memory fact with invented statements.

Live results on the owner's memory (13 November, Gemini under load):

| Question | Result |
| --- | --- |
| What is the Graduate Route visa? | From GOV.UK: at least 18 months after an eligible course, apply from inside the UK on a Student visa; 6.6 s total |
| How much is the Immigration Health Surcharge (for students)? | From GOV.UK: £776 per year, £1,552 for a 2-year visa, £388 for 6 months or less from inside the UK (all checked against the page), combined with the memory's “I'll pay it when I apply”; 5.8–13 s to first words |
| How much money do you need to show for a Student visa? | From GOV.UK: £1,529 a month in London, £1,171 outside London, for up to 9 months |
| What is the population of Leicester? | From Wikipedia: 383,116 in 2025; 4.4 s |
| Do you have any relatives in the UK? | “Not in memory”, not searched |
| Why did you choose Leicester? / Who is your sponsor? / Why this course? | From the memory only, full length, 1.1–1.7 s to first words; no web lookup |

Limitations:

- Only Wikipedia (introductions) and GOV.UK are searched. University-specific facts (module lists, current rankings, fees) are often not found and give “Not in memory”; put such facts in the memory.
- Web answers start later (about 5–13 s) because they need the memory step, the lookup decision, the search and the web step; on Gemini's busy days they can take longer. A memory answer that is completed with web facts starts at normal speed, and the web part arrives while the viewer is still reading.
- The page choice is keyword based and the small model is not perfectly consistent: the same question can occasionally give “Not in memory” on one try and an answer on the next.
- Wikipedia rate-limits clients without contact details (seen as HTTP 429 during heavy testing; GOV.UK still answered). `WEB_SEARCH_CONTACT` can identify the app to Wikipedia; it is empty by default because it would send personal details.
- A web-backed answer uses 3–5 Gemini requests instead of 1, which counts against the free daily quota.
- Facts from GOV.UK are current when asked; the memory wins if it disagrees, so keep figures in the memory up to date (for example GOV.UK showed £1,529/£1,171 a month for maintenance on 13 November).
- Google states that free-tier content may be used to improve its products. Questions are sent to Wikipedia and GOV.UK as short topic names only, never with memory content.

## Made-up answers for soft questions — 13 November 2026

At the owner's request, soft questions about the applicant that the memory does not answer are no longer “Not in memory”. Agreed rules: checkable facts about the applicant (for example height) stay “Not in memory”; soft questions (for example “How have you used advice from teachers to get better at school?”) get a made-up answer; the answer stays general, with no invented details; it is marked on the viewer; the reason for a study gap counts as soft.

How it works:

1. The memory step is unchanged, so whatever the memory covers is answered from the memory (live: “Why did you have a gap in your studies?” answered from the memory that there was no gap; “How do you handle pressure?” used the memory's real workload).
2. The lookup step (`LOOKUP_RULES`) now has three replies: `PERSONAL` (a checkable fact about the applicant, or whether something is true about them; also the choice when unsure), `REFLECTIVE` (how they think, work, feel or deal with things, including reasons such as a study gap) and `SEARCH:` (a general fact).
3. `REFLECTIVE` gets an answer under separate rules (`MADE_UP_FACTS`): believable general habits, approaches, reasons and lessons that fit everything in the memory and never contradict it; never invented names, places, dates, years, numbers, grades, scores, awards, competitions, employers, qualifications, people or specific events; nothing checkable in documents. If an answer would need such a fact, the reply is still “Not in memory”.
4. A short memory answer to a soft question gets general made-up points added after it (marked from that point). A too-short made-up answer is extended with more general points.
5. Made-up text carries the `[made-up] ` marker. The viewer shows it in blue with the badge “Made up — not from your memory” (or “Blue part is made up — not from your memory” after a memory part). Web text stays amber. `src/lib/answer-marker.ts` reads both markers.

Live results on the owner's memory (13 November, Gemini slow; backups engaged on most questions):

| Question | Result |
| --- | --- |
| How have you used advice from teachers to get better at school? | Made up, general, fits the memory (feedback on code and project work, system design, testing); no names, dates or grades; 11.6 s to first words |
| What is your height? | “Not in memory” |
| Why did you have a gap in your studies? | From the memory: no gap, January intake straight after the BSc; 1.6 s |
| How do you handle pressure? | From the memory's real workload (BSc, internship, tutoring, client work); nothing made up |
| Do you have any relatives in the UK? | “Not in memory” |

Limitations:

- A made-up answer is not true information about the applicant. It is marked so the reader can stay general and careful with follow-up questions, because interviewers compare answers with documents and earlier answers.
- Answers that need the lookup step (made up, web, or “Not in memory” for a question the memory does not cover) start later than memory answers: about 3–5 s normally, and 7–12 s when Gemini is slow, as on 13 November.
- The PERSONAL/REFLECTIVE choice is made by the small model; borderline questions can fall either way. When unsure it chooses PERSONAL (“Not in memory”).
