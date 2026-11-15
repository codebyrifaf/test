# Confirmed requirements and implementation contract

Current authorization: the user's complete-application brief, reviewed 2026-11-04 (Asia/Dhaka), supersedes the earlier step-by-step restriction. Original Steps 3–10 are implemented in this run. See the final report for verified results rather than treating historical Step 1 statements as current status.

## Session and roles

- Exactly one globally live session, enforced by an atomic create operation and a unique partial database index.
- One sender credential slot and one viewer credential slot. Random private join code; opaque reconnect cookies; only token hashes stored in PostgreSQL.
- Person A creates, reconnects, submits continuously, sees safe statuses and delivery acknowledgement, and quits. Person A never receives answer text through sender APIs or state.
- Person B joins using the code, reconnects in the original browser, sees complete answers, adjusts scrolling speed, uses fullscreen when supported, and quits.
- Both explicit quits terminate normally. One quit leaves the other participant active.
- Presence heartbeats run every 15 seconds. A connection becomes stale after 45 seconds. Both disconnected starts a ten-minute deadline; either reconnect cancels it. Cron and atomic access/create reconciliation clean expired sessions. Termination deletes transient answer state.

## Question ordering and display

- Questions receive monotonic database sequence numbers after locking the session. Request IDs provide idempotency. No arbitrary total question-count cap; input sizes and short-term rate limits apply.
- New questions supersede older queued/processing questions immediately. Durable leases and publication checks reject stale, expired, or superseded results across workers. In-process cancellation is an optimization only.
- Latest valid answer is delivered only to the viewer through authenticated SSE with polling fallback. Delivery acknowledgements update sender status without answer content.
- Each answer appears in one continuous horizontal line moving right to left. Full text is retained, with no ellipsis or answer-length summarization. It clears after the last character exits and never loops automatically.
- Changing speed preserves position. A new answer replaces the current one. A genuine reconnect restores the latest available answer once. No pause/resume/replay controls.
- AI errors remain sender statuses. They do not replace a valid scrolling answer with an error ticker.

## Permanent knowledge and uploads

- Password-protected minimal administrator interface using a user-configured `ADMIN_PASSWORD`, independent strong signing secret, signed HTTP-only cookie, expiry, same-origin writes and login rate limiting.
- All knowledge management reads/writes are server authorized. Manual create/edit/delete/activate/deactivate, search, duplicate detection and alternative question phrasings.
- Prepared answer text is stored exactly as approved, never rewritten by matching AI.
- PDF, DOCX, XLSX, CSV and TXT extraction. Reviewed Q&A imports require explicit approval and allow corrections; incomplete pairs are reported, not invented. Duplicate save batches fail atomically.
- Private reference storage, extraction, overlapping chunks, optional reusable 768-dimension embeddings and keyword fallback. Delete removes private file and chunks. Large indexing tasks continue in explicit bounded batches.
- Bounded upload bytes, text size, PDF page count and archive expansion. No macro/script execution. Scanned documents require external OCR. Extracted references are untrusted data, never application commands.

## Gemini pipeline

1. Exact normalized question/alias lookup bypasses AI completely.
2. Otherwise retrieve candidate questions by keyword and optional semantic similarity; Gemini returns structured candidate ID/no match. Validate candidate membership and intent/confidence. Re-read the original active prepared answer.
3. Without a reliable match, retrieve relevant ready reference chunks and generate a complete answer, permitting general knowledge and requiring uncertainty when evidence is insufficient.
4. Do not permanently store generated answers in knowledge or answer history. Only the latest temporary answer is retained for delivery/reconnection and deleted at termination.

Model IDs and budgets are configurable. No automatic billing or paid-provider fallback. Quota/auth failures are not repeatedly retried. Temporary provider failures get at most one retry; empty, malformed, incomplete or timed-out outputs fail safely. Exact/keyword lookup remains usable when optional embeddings are unavailable.

## Security and verification boundaries

Privileged Supabase/Gemini keys and admin credentials remain server-only. Tables use forced RLS and no direct anonymous/authenticated access; application RPCs are service-role only. Mutations check origin. Participant authorization is role- and session-scoped. Errors are sanitized, and logging does not include credentials or complete documents.

Required verification includes TypeScript, ESLint, production build, page loading, two independent browser contexts, session exclusion, exact delivery, ticker lifecycle, latest-question fencing, provider integration, failure handling, reconnect, controlled-time expiration, cleanup and browser-secret checks. Distinguish deterministic tests from live services. A dedicated administrator-panel/authentication audit, visual design audit and production hardening are outside this run.

## Database change rules

The owner applies SQL manually in the Supabase Dashboard. Never independently push migrations, reset the remote database, delete existing tables or edit an applied migration. All four existing migration files are confirmed applied. Future schema changes require a new migration and explicit deployment confirmation. Dashboard execution does not create CLI migration history.
