# Model failover verification — 4 November 2026

Relay now defaults to `gemini-3.5-flash-lite` and switches to a backup model after a transient provider failure. Relevance matching and answer generation both use this behavior, while remaining separate stages. An AI failure is never treated as a successful “no match.”

**Actual provider checks**

| Model | Matching | Generation |
| --- | --- | --- |
| `gemini-2.5-flash-lite` | HTTP 404 | HTTP 404 |
| `gemini-3.1-flash-lite` | Passed, 1.6 seconds | Passed after HTTP 503 and 504, 63.3 seconds total |
| `gemini-3.5-flash-lite` | Passed, 1.6 seconds | Passed, 0.7 seconds |

These were real synthetic-question requests with the configured key. Model-list membership did not prove usability: 2.5 Flash-Lite was listed but rejected actual requests. 3.5 Flash-Lite's standard API has a documented [free tier](https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite). Billing settings and credentials were not changed; free-tier eligibility does not establish the billing state of an individual project.

**Model policy**

- Default primary: `gemini-3.5-flash-lite`.
- Default backup: `gemini-3.1-flash-lite`. When an existing primary override names another model, the default backup is `gemini-3.5-flash-lite`.
- `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL` can override the pair. An empty fallback value disables switching. A backup equal to the primary is deduplicated.
- Attempt 1 uses the primary. After a retryable 500/502/503/504 response, transport failure, or attempt timeout, attempts 2 and 3 use the backup. Existing exponential backoff, Retry-After, cancellation and persisted request budgets remain enforced.
- Three attempts total per stage, not three per model. The shared worker deadline remains 105 seconds, with 30-second provider attempt timeouts.
- Quota, authentication, invalid input, unavailable model and invalid response errors do not trigger switching. No automatic paid-only model or new provider was added.
- The same prompt and matching schema are sent to the backup. Selected IDs must still belong to the retrieved candidates. Prepared answers still come unchanged from Supabase; generated text cannot replace an exact prepared answer.
- Diagnostics record `modelSlot: primary` or `fallback` alongside the attempt number without logging prompt/answer content or credentials.

**Live workflow results**

Two independent Chrome contexts used `http://localhost:3000` and `http://192.168.1.138:3000`. All eight verification groups passed:

1. Create and join the private session across origins.
2. Exact prepared answer: unchanged bytes, no AI budget usage, sender privacy, scrolling once, clearing and stored acknowledgement.
3. New question: separate candidate matching and generation with the new default model; correct answer reached the viewer and cleared after one scroll.
4. Primary-model outage: the isolated test worker used 3.1 Flash-Lite as primary and injected a 503 for that model only. The real 3.5 Flash-Lite backup answered the relevance-selection request in about 820 ms. It selected the correct stored answer for a non-exact question; `prepared_read` and publication succeeded, generation was not called, and the viewer received the original answer and scrolled it once. This distinguishes the simulated primary outage from the live backup response. SDK-level automated tests also verified the default 3.5-to-3.1 switching direction using simulated responses.
5. Both-model outage: injected 503 for every generation request; failure after three delayed attempts, safe sender message, no viewer error, previous valid answer retained.
6. Obsolete leased request rejected; newest exact answer still delivered after provider failure.
7. Both participants quit and global session creation became available; no browser runtime errors.
8. Server diagnostic events confirmed matching, generation, publication and acknowledgement.

TypeScript, ESLint, production build and all **86 automated tests** passed (7 Supabase, 55 application, 12 foundation database, 12 session database). The user authorized closing the remaining real session; it was terminated before test setup. Only owned temporary test sessions and prepared fixtures were deleted afterward. No admin-panel verification or migration application occurred.

Evidence: `.verification/model-alternatives-results.json`, `.verification/additional-model-results.json`, `.verification/question-processing-live-results.json`, and `.verification/question-processing-server-events.json`.

**Files changed in this follow-up**

`src/lib/ai/provider.ts`, `src/lib/ai/provider-request.ts`, `src/lib/server/processing-diagnostics.ts`, `tests/provider-failover.test.ts`, `scripts/verify-question-processing.mjs`, `package.json`, `.env.example`, `README.md`, and the diagnostic reports under `docs/`.

**Remaining limitation and actions**

No new key, billing change, or SQL migration is required. The existing environment has no explicit primary/backup overrides, so the new defaults apply. Create a new session and resubmit failed questions. Both models are hosted by Google: a provider-wide outage can still prevent semantic matching and generation. Continuing through that kind of outage would require an independent AI provider or a local model; model failover does not guarantee uninterrupted service.
