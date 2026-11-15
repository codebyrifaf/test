# Implementation map

The complete-application authorization superseded the original stop-after-each-step process. Existing UI and database foundations were preserved; original Steps 3–10 were implemented together. Actual test outcomes and limitations belong in `docs/final-implementation-report.md`.

| Original step | Implemented area | Main code |
| --- | --- | --- |
| 1 | Existing Next.js/React/Tailwind workspace and routes | `src/app`, shared shell/navigation |
| 2 | Supabase clients, typed schema, health route, private database/storage foundation | `src/lib/supabase`, first two migrations |
| 3 | Atomic single-session lifecycle, cookies, presence, cron expiration | Application/schedule migrations; `src/lib/server`, session API routes |
| 4 | Sender composition, idempotent submission, sequence and lease fencing, statuses | `sender-workspace.tsx`, questions route, AI worker |
| 5 | Authenticated SSE, polling fallback, reconnect and single-pass ticker | `viewer-workspace.tsx`, `answer-ticker.tsx`, viewer routes |
| 6 | Minimal signed-cookie administrator access | Admin session route, server security, admin workspace |
| 7 | Prepared knowledge CRUD, aliases, exact matching and reviewed imports | Admin Q&A/import routes, SQL aliases and search |
| 8 | Five-format private uploads, extraction/chunking and reusable embeddings | `src/lib/knowledge`, document/index routes |
| 9 | Gemini structured intent matching and reference-supported generation | `src/lib/ai/provider.ts`, `pipeline.ts`, `worker.ts` |
| 10 | Deterministic/live verification, error fixes and operating documentation | `tests`, verification scripts/SQL, README, final report |

## Architectural guarantees

- The database enforces uniqueness, authorization preconditions, order, leases, supersession and final publication; React state and in-memory cancellation are not authoritative.
- Sender API projections are explicit allowlists with no answer field. Viewer endpoints require the separate viewer credential. Knowledge endpoints require the administrator cookie.
- Prepared answers remain original stored text. Generated answers are transient and never inserted into permanent knowledge.
- Streaming is server mediated; application tables and private documents remain inaccessible to public Supabase clients.
- Presence and cleanup depend on timestamps and a confirmed working scheduler, with atomic cleanup during creation as a fallback.
- Upload review, parser limits, independent provider budgets and unchanged-content hashes bound cost and prevent silent import decisions.

## Deployment and further work

No public deployment is performed. First perform the documented two-laptop trial on a trusted LAN. A production deployment needs HTTPS, correct origin/proxy settings, adequate route runtime, an admin/security review, storage/parser abuse controls, operational monitoring and a retention policy for question/session metadata.

All four SQL migrations were applied manually by the owner. Do not reapply them. Reconcile CLI migration history with an authorized account before a future `db push`. The existing CLI login's permission failure was not bypassed.

Future changes should preserve the tested contracts, read this Next.js version's local documentation under `node_modules/next/dist/docs`, add new migrations for schema changes, and rerun relevant deterministic and live checks. Do not claim tests that did not actually execute.
