# Relay dashboard role visibility and synchronization fix

Date: 2026-11-04 (Asia/Dhaka).
Project: `C:\Users\USER\Desktop\ukvi`.
Final status: **Fully Fixed** for the requested dashboard behavior and verified localhost/LAN setup.

## 1. Root cause

The original home dashboard always rendered both role cards, used only a boolean availability response, and polled every ten seconds. It did not know which browser owned a role, whether a viewer had already joined, or whether a participant had explicitly quit. A creation conflict also did not immediately refresh availability. Consequently an occupied sender card remained visible and dashboards could present stale actions.

Live LAN testing found a second cause: this Next.js version requires additional development hostnames in `allowedDevOrigins`. The current LAN address was not allowed. Chrome reported failed development WebSocket connections and the LAN dashboard stayed on its initial checking message. Allowing the confirmed local hostname restored hydration and polling. The final three-context test verified the correction.

## 2. Exact files changed

| File | Change |
| --- | --- |
| `src/components/home-workspace.tsx` | Conditional role cards, owner workspace links, loading/error restrictions and immediate conflict refresh |
| `src/lib/use-session-availability.ts` | New two-second polling hook, focus/online refresh, cancellation, stale-response protection and safe failure behavior |
| `src/lib/server/dashboard.ts` | New server-only Supabase occupancy/quit lookup and authenticated cookie-hash ownership projection |
| `src/app/api/session/availability/route.ts` | Returns the role-aware dashboard projection with no-store and Vary: Cookie |
| `src/types/session.ts` | Typed dashboard state and role flags |
| `next.config.ts` | Allows the verified development hostname `192.168.1.138` |
| `tests/availability.test.ts` | Eleven availability/ownership/security regression tests |
| `scripts/verify-session-availability.mjs` | Repeatable live three-browser localhost/LAN regression harness |
| `package.json` | Includes availability tests in `test:application` and therefore `npm test` |
| `docs/dashboard-role-visibility-fix.md` | This report |

Ignored local verification files created/updated: `.verification/close-abandoned-session.mjs`, `.verification/probe-lan-dashboard.mjs`, `.verification/session-availability-results.json`. Normal test/build commands also regenerate ignored Next.js outputs. No applied migration, AI implementation, ticker implementation, participant session API or admin feature was changed.

## 3. Dashboard behavior implemented

- **No live session:** show Create Sender Session and the initial Viewer card. Only creation is enabled; the viewer input/action waits for a sender.
- **Loading or failed availability:** no actionable creation. A background check disables any existing creation button; a failed check removes actionable role cards until recovery.
- **Sender waiting:** the authorized sender sees Sender Active and Return to sender workspace, with no second-create action. Other browsers completely lose the sender card and see only Join as Viewer with the sender-active instruction.
- **Both roles occupied:** A and B each see only their authorized workspace-return card. Other browsers see neither role action card and receive “Session in progress — both roles are occupied.”
- **One participant quits:** that browser loses its owned-role card. Both slots remain reserved until termination; there is no replacement sender/viewer action. The remaining authorized participant keeps its workspace link. The status identifies which participant quit.
- **Both quit or session expires:** all dashboards automatically return to the initial two-card state and creation becomes available again.
- Opening `/sender` without an authorized cookie does not create or reserve a session.

The existing grid, role colors and card styling are reused. This is a behavior correction, not a visual redesign.

## 4. Cross-browser synchronization method

Every mounted home dashboard requests the same server endpoint immediately and then two seconds after each completed check. Focus, restored visibility and online events trigger an immediate refresh. Requests use no-store caching. Polling does not overlap; a newer refresh cancels the older request, and request versions prevent older results from overwriting newer state. Offline/failure states cannot leave an old available state actionable.

Creation/join failures trigger an immediate availability refresh before clearing the busy state. This lets a race loser show the existing clear conflict message and remove its sender card.

The server runs the existing Supabase expiration reconciliation before reading the current non-terminated session and its participant records. Database state determines occupancy, quit flags and ownership. Browser state is only a temporary rendering cache; localStorage is not used.

## 5. Security checks

- The existing participant cookie reader validates and hashes the opaque role credential. Ownership additionally requires the matching hash and role in the selected live session, no explicit quit/revocation, and an unexpired credential.
- Invalid, unrelated, wrong-role, revoked and expired credentials cannot establish ownership. A forged browser cookie was tested live and received no owned roles.
- Availability returns only `available`, `status`, `senderOccupied`, `viewerOccupied`, `senderQuit`, `viewerQuit`, and `ownedRoles`. It does not return session IDs, private codes, participant hashes/tokens, questions, answers or keys.
- Responses use `Cache-Control: no-store` and `Vary: Cookie` because ownership differs between browsers.
- Database RLS, service-only permissions, the single-session constraint and atomic create/join operations remain intact. No new public database permissions were created.
- Direct wrong-role API access returned 401. A new viewer could not take over an explicitly quit viewer slot. Simultaneous live creation produced one HTTP 201 and one HTTP 409.
- The existing abandoned waiting session was terminated only after the user explicitly authorized that action. Live verification subsequently created and removed only uniquely identified test sessions and Q&A.

## 6. Tests executed and actual results

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, zero warnings |
| `npm run build` | Passed |
| `npm test` | Passed all 62 deterministic tests: 7 Supabase, 31 application, 12 foundation database, 12 session database |
| `node scripts/verify-session-availability.mjs` | Passed all 11 grouped live checks using three independent Chrome contexts and actual Supabase |
| LAN hostname verification | `ipconfig` confirmed Wi-Fi IPv4 `192.168.1.138`; harness also checks actual OS interfaces |

Live origins: A at `http://localhost:3000`, B at `http://192.168.1.138:3000`, and independent C at `http://localhost:3000`. The final harness verified:

1. Initial cards and disabled creation while the first check is held; initial Join disabled.
2. Direct `/sender` navigation does not reserve a session; missing credentials denied.
3. A failed availability request removes stale actions, then polling recovers.
4. A creates; B/C automatically lose the entire sender card; A recognizes ownership. A deliberately delayed older response cannot restore the card.
5. B joins with the private code. A/B retain the correct return links, and C has neither action card. Availability exposes no private code/credentials.
6. Cross-origin role isolation, question submission, exact prepared answer delivery, horizontal movement, speed adjustment and viewer reload/reconnection still work.
7. B quits: its ownership disappears, A remains authorized, and a replacement viewer receives a conflict.
8. A then quits: every open dashboard automatically returns to the initial state.
9. Two gated, simultaneous UI create requests produce exactly one success and one conflict. The loser refreshes and hides its sender card.
10. Controlled timestamps applied only to the test session trigger real Supabase expiration; every dashboard restores the original cards without manual refresh.
11. No browser runtime errors; no admin-panel verification performed.

Initial failing checks were corrected and rerun. The LAN hydration failure led to the development-host allowlist fix. A ticker-motion assertion initially ran in a hidden observer tab, where Chrome suspends animation frames; the harness now brings the viewer forward before measuring movement. The ticker implementation was not modified. A temporary approval-review usage-limit failure was resolved by a later successful retry after the user requested continuation.

AI matching/fallback and latest-question-wins regression tests passed. No additional live Gemini call or admin workflow test was needed for this focused change. Live browser testing used the development server on port 3000; the production build was verified separately.

## 7. Required manual actions

None for the current localhost/LAN setup. No SQL migration is required or was applied. The development configuration has already reloaded, and test fixtures were removed.

If the machine later receives a different LAN IP, update the hostname in `next.config.ts` under `allowedDevOrigins` and use the new LAN URL. The live harness intentionally checks the configured IP against actual interfaces before running. It requires an idle project and the existing local Playwright installation under `.verification/node_modules`.

## 8. Final status — Fully Fixed

The requested role-based visibility, authorized ownership, automatic synchronization, quit/expiry recovery and concurrent creation protection all passed live verification across the two requested origins. No admin-panel verification or unrelated feature changes were performed.
