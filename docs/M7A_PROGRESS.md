# M7A Progress Log — Release Readiness and Product QA

Recovery-safe log. Updated after each completed unit so an interrupted
session can resume from the repo alone.

## Recovery (2026-10-23)

- Resumed from `main` @ `cb93dda` (M6). No M7A commit existed.
- `git status --short`: clean tracked tree; only untracked artifacts from
  the interrupted session:
  - `m7a-qa1.cjs`, `m7a-qa2.cjs`, `m7a-qa2b.cjs`, `m7a-dbg.cjs` — CDP QA
    scripts (system Chrome headless + Node WebSocket, no new deps).
  - `.tmp-m7a-*` — Chrome profile/download dirs created by those scripts.
- No tracked source changes were lost or duplicated. Baseline verified:
  `npm --prefix app run test:run` → 14 files / 144 tests pass;
  `npm --prefix app run build` → clean; `npm --prefix app run lint` →
  clean; `git diff --check` → clean.
- Missing at resume: root `README.md`, `docs/RELEASE_CHECKLIST.md`,
  `docs/DEMO_PLAN.md`, this log; `docs/TESTING.md` ends at M6.

## M7A scope (release hardening, not features)

- [x] A. End-to-end functionality QA (canonical isolation, export bytes)
- [x] B. Browser + accessibility QA (desktop, 360px, keyboard, labels)
- [x] C. Product polish (only genuine issues, keep architecture)
- [x] D. Security review (secrets server-side, redaction, proxy limits)
- [x] E. Docs: README, RELEASE_CHECKLIST, DEMO_PLAN, TESTING (M7A section)
- [x] Terminal-instability investigation (non-destructive, lightweight)
- [x] Verification: test:run + build + lint + diff --check
- [x] Local commit (no push/deploy) — `0c5577b`

## QA runs

- PASS `m7a-qa1.cjs` (workspace, preservation, proposals, 2026-10-23):
  agent connect; 1 iframe across Studio->Lab->Studio switches; canonical
  design unchanged by switches; explorer conn + schema; empty-prompt
  error; prepare -> "1 change across 1 block", canvas untouched;
  approve -> canvas updated; stale rejected with external edit kept;
  discard; zero console errors. (Read-design single-shot timing flake
  resolved by retry loop in P2.)
- PASS `m7a-qa2.cjs` (isolation, export status, autosave, restore, a11y):
  AI unconfigured note + Generate disabled; autosave key with marker;
  5 scenarios pass / 0 fail; canonical design JSON byte-identical
  before/after (3068 = 3068); read-design lists seed-p; export status
  "Exported 6 evidence entries."; reload restores marker; 10 tabbable,
  0 positive tabindex; zero console errors. Headless file-download
  capture failed (harness limit, see below).
- PASS `m7a-qa3.cjs` (export bytes via in-page blob hook + 360px):
  exact downloadable bytes captured: 2051 B, keys
  [exportedAt, generator, warning, entryCount, entries], entryCount 5 =
  entries 5, no `designs` by default, warning ok, generator
  `unlayer-agent-lab`, zero key-like leaks, sources [simulated]; opt-in
  snapshot adds `designs.currentDesign` (6174 B, sanitized, no leaks);
  0 unlabeled buttons; 4 live regions; 360px viewport: docScroll 360 =
  innerWidth, no horizontal overflow. Zero console errors.
- PASS `m7a-qa4.cjs` + `m7a-qa5.cjs` (XSS probe + keyboard):
  payload `<img src=x onerror=alert(1)>` -> 0 live `img` in Studio DOM,
  no live tag in innerHTML; stored `values.text` holds `&lt;img` with no
  live open tag (raw text only inside Lexical `textJson`, by design,
  rendered as text); genuine Tab order logical with solid 2px
  `:focus-visible` outline on every stop (P4 programmatic-focus
  `outline:none` reading was correct browser behavior, not a bug).
- headless-download limit: `Browser.setDownloadBehavior` + trusted CDP
  click + direct in-page blob click all report success status but leave
  no file on disk (`m7a-dbg.cjs` probe: zero `downloadWillBegin`
  events). App layer verified exactly (blob bytes above); the anchor-
  download plumbing is Chrome's. Documented as a manual spot-check in
  RELEASE_CHECKLIST.

## Product changes (minimal, hardening only)

- Deleted `app/src/App.css` — dead Vite-template leftover, never
  imported (`main.tsx` imports only `index.css`; verified zero refs).
- Added `:focus-visible` outline (2 px solid `#1d4ed8`, offset 2 px) for
  buttons, textareas, inputs, and summaries in `app/src/index.css`.
  Verified with genuine Tab presses: solid 2 px outline on every stop.
- No engine, Lab, server, or behavioral changes. No redesign.

## Security review (2026-10-23)

- Bundle grep `unlayer_sk_|UNLAYER_API_KEY` over `app/dist/assets/*.js`:
  0 matches. Only `app/server/ai-server.ts` touches the key.
- Browser sends same-origin `/api` fetches, no `Authorization` header
  (unit-tested in `aiProvider.test.ts`).
- `sanitizeForExport` redaction unit-tested; captured export bytes
  (default + opt-in) contain zero key-like strings.
- Server binds 127.0.0.1, no auth/rate-limit BY DESIGN for local dev;
  `.env` gitignored; logs redact key presence. Public deployment needs
  auth + rate limits + key budget (documented in README + checklist).
- localStorage keys hold designs only, never credentials; scenarios
  never write storage (unit-asserted zero I/O).

## Terminal-instability investigation (lightweight, non-destructive)

- Memory: 8 GB total, ~1.9 GB free during QA (~76% used) — real
  pressure on this laptop. Each headless-Chrome QA run costs several
  hundred MB; runs were sequential with one Chrome at a time.
- QA hygiene confirmed: no lingering `--remote-debugging-port` Chrome
  processes after the runs (all harnesses `kill()` their browser);
  remaining `chrome.exe` processes are the user's normal browser.
- Pi sessions persist under `~/.pi/agent/sessions` (this repo's session
  dir updated normally); no crash logs found in obvious locations.
- Likely cause: memory pressure from Vite + headless Chrome + editor
  stack on 8 GB RAM closing the host terminal. Prevention: run one
  heavy thing at a time, always kill QA browsers (done), stop the dev
  server when finished, avoid parallel build/test/browser runs.
- No system, terminal, or global Pi settings were changed.

## Decisions (carried from recovery)

- Reuse the interrupted session's QA scripts verbatim; do not rewrite.
- After QA, record evidence here + `docs/TESTING.md`, then remove
  `.tmp-m7a-*` profiles and root `m7a-*.cjs` harnesses (one-off tooling,
  not product) for a clean release tree.
- No live AI verification possible without `UNLAYER_API_KEY`: gate stays
  BLOCKED; all other work completes.
