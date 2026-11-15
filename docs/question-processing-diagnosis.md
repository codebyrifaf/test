# Question processing diagnosis — 4 November 2026

Follow-up: the application now defaults to Gemini 3.5 Flash-Lite and supports controlled model failover. See [model failover verification](model-failover.md) for the subsequent change and live recovery test. The original failure evidence below remains relevant.

**Current outcome:** application retry handling and diagnostics are improved and verified. Gemini availability remains intermittent. Submission #29 still failed because all three provider attempts returned HTTP 503; this external failure is not resolved by the application changes.

**Root cause and evidence**

- Submission #20 was accepted, claimed by the worker, and recorded as `failed / AI_UNAVAILABLE` after about 11.5 seconds. No delivery acknowledgement was recorded. Its original underlying exception was discarded by the old worker, so the exact historical provider response cannot be reconstructed.
- Initial live probes using the configured `gemini-3.1-flash-lite` model returned HTTP 503 for both structured matching and ordinary generation. Replaying #20 later succeeded through semantic matching and returned the original prepared answer. The model is available, but requests intermittently fail.
- Submission #29 supplies conclusive stage-level evidence: exact lookup, embedding, and prepared candidate retrieval succeeded; `candidate_match` received HTTP 503 on attempts 1, 2, and 3 (15,044 ms, 11,075 ms, and 2,595 ms). The matching stage failed after 35,504 ms. Supabase successfully recorded `AI_UNAVAILABLE`; `delivered_at` remains null.
- These 503 responses establish a provider service-availability failure. They are not evidence of quota exhaustion (429), rejected credentials (401/403), a missing model (404), or a request timeout. Google's [API error reference](https://ai.google.dev/gemini-api/docs/generate-content/api-errors) describes 503 as temporary service overload or unavailability.

**Failed component and why the viewer stays empty**

`matchPrepared()` calls `generation()` to ask Gemini whether a retrieved prepared question matches the incoming question's intent. When this request fails, `resolveAnswer()` cannot safely choose a stored answer and does not treat the failure as a legitimate “no match.” It therefore does not enter fallback generation. `processLatestQuestion()` records the safe failure through `relay_finish_question`. There is no new answer to publish, deliver, or acknowledge. Sender polling returning HTTP 200 only confirms that status retrieval works.

**Changes**

- Three bounded provider attempts with exponential delays (2 and 4 seconds plus jitter), support for `Retry-After`, and cancellation during waits. The existing shared 105-second worker deadline and 30-second attempt timeout remain in effect. Each attempt consumes the persisted request budget.
- No retries for authentication, invalid request, missing model, quota, or invalid output errors. Matching and generation remain separate stages. No model, credentials, billing settings, or SQL schema were changed.
- Structured server logs contain a correlation ID, question ID, stage, safe category, provider HTTP status when available, durations, timeout and retry information. They omit question/answer content, credentials and raw provider bodies.
- Database failures during AI budget checks retain their database classification instead of being mislabeled as AI rate limits. Publication and viewer acknowledgement are logged. Obsolete publication results and failed failure-publication attempts are visible.
- The sender receives a simple temporary-unavailability message. The viewer receives no internal error. Exact prepared answers, role privacy, latest-question fencing, scrolling and session behavior remain intact.

**Files changed**

| Files | Purpose |
| --- | --- |
| `src/lib/ai/provider-request.ts`, `src/lib/ai/provider.ts` | Bounded retries, classification, preserved HTTP status and budget errors |
| `src/lib/server/processing-diagnostics.ts` | Correlation context and safe structured logging |
| `src/lib/ai/pipeline.ts`, `src/lib/ai/worker.ts` | Stage tracing, publication diagnostics, cancellation cleanup |
| `src/lib/server/errors.ts` | Preserve database error codes for server diagnostics |
| `src/app/api/questions/route.ts`, `src/app/api/viewer/ack/route.ts` | Submission and acknowledgement tracing |
| `src/components/sender-workspace.tsx` | Safe temporary-unavailability message |
| `tests/provider-request.test.ts`, `package.json` | Retry/error/diagnostic regression tests |
| `scripts/verify-question-processing.mjs` | Live two-origin sender/viewer verification with owned temporary fixtures |
| `docs/question-processing-diagnosis.md` | This report |

**Verification performed**

- TypeScript, ESLint and production build passed.
- All 77 automated tests passed: 7 Supabase, 46 application, 12 foundation database, 12 session database tests. New coverage includes transient recovery, bounded exhaustion, Retry-After, cancellation, timeout, non-retryable errors and diagnostic redaction.
- Live Chrome contexts at `http://localhost:3000` and `http://192.168.1.138:3000` created and joined a temporary session.
- Exact prepared answer: original whitespace/text preserved, AI request budget unchanged, answer visible only to the viewer, scrolling motion observed, single pass cleared, acknowledgement persisted.
- Live fallback: a retrieved candidate with different intent was rejected; separate Gemini generation produced the correct answer; publication, viewer scrolling/clearing and acknowledgement succeeded. Server logs independently confirmed both matching and generation stages.
- Controlled provider failure: injected HTTP 503 at the real SDK transport boundary; the real worker and Supabase recorded failure after three delayed attempts, the sender showed the safe message, and the viewer's previous valid answer was preserved without replay or error delivery. This test used injected failures; the earlier probes and #29 were actual provider failures.
- Latest-question-wins: an obsolete valid lease could not overwrite the newer published answer. Exact answering still worked after the injected provider failure.
- Both participants quit normally; creation became available. Owned temporary sessions and prepared fixtures were removed. No admin-panel verification or migration application was performed.

The initial browser attempt stopped because port 3000 was not running. The server was started and the workflow then passed. The live harness's development-log parser was corrected after the run to handle Next's JSON encoding; the retained log events were independently parsed and checked. No live workflow was rerun against the user's newly active session.

Local evidence is retained in `.verification/question-processing-live-results.json`, `.verification/question-processing-server-events.json`, `.verification/observed-question-trace.json`, and `.verification/submission-29-diagnosis.json`.

**Manual actions / remaining limitation**

No Supabase migration or replacement key is required by this fix. During the provider outage, an exact prepared question can still return its stored answer without Gemini. A failed submission must be submitted again after availability recovers. Persistent 503s require provider recovery or a separately verified available model/provider; no automatic paid-model fallback has been enabled. Increasing retries cannot guarantee availability.
