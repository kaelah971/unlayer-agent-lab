# Testing — Unlayer Agent Lab (M2)

## How tests run

- **Runner:** Vitest 5 in Node mode (no browser, no jsdom, no Docker).
  Pure business logic only — fast enough for an 8 GB Windows laptop
  (~300 ms for the whole suite).
- **Commands** (from the repo root):
  - `npm --prefix app run test:run` — single run (CI / verification).
  - `npm --prefix app run test` — watch mode for development.
- **Type safety:** test files live under `app/src` and are included in
  `tsconfig.app.json`, so `npm --prefix app run build` (`tsc -b`)
  type-checks tests as well as production code. Vitest itself does not
  type-check; never skip the build step.
- **Lint:** `npm --prefix app run lint` covers tests too.

## What is covered (17 tests, `app/src/engine/proposals.test.ts`)

All tests exercise the real production module `app/src/engine/proposals.ts`
— no duplicated logic, no re-implemented transforms.

**Preparation (`prepareParagraphEdit`)**

| # | Case | Guarantee |
|---|---|---|
| 1 | Valid replacement | `before`/`after` captured, canvas untouched, base snapshot stored |
| 2 | Empty / whitespace input | Rejected with `Enter replacement text first.` |
| 3 | Missing paragraph / null design | Rejected with `First content block…` (null fails closed, no `TypeError`) |
| 4 | Unsupported block type (image first) | Rejected with `First content block…` |
| 5 | Locked paragraph | Rejected with `First content block…` |
| 6 | Malformed `textJson` / wrong shape | Throws (raw parse error, or safe-update error for valid-JSON-wrong-shape) |
| 7 | Original not mutated | `structuredClone` first; input byte-identical afterwards |
| 8 | `textJson` ↔ `text` consistency | Lexical node holds raw text; HTML holds escaped text |
| 9 | HTML / `$`-pattern escaping | `<img onerror>` lands escaped in HTML, verbatim in JSON; `$&` inserted literally via replacer fn |
| 16 | Unrelated blocks preserved | Image/button siblings deep-equal after preparation |

**Approval (`approveEdit` + `isDesignChanged`)**

| # | Case | Guarantee |
|---|---|---|
| 10 | Valid approval | Backup written before load, candidate passed to `loadDesign`, `onApplying` fired, outcome `applied` |
| 11 | Discard | Preparation is side-effect free; runner with `null` does zero I/O (`skipped`) |
| 12 | Changed design | Outcome `stale`; no backup, no load, no status callback |
| 13 | Native validation failure | `errors[].message` joined (`; `) into `rejected`; backup still precedes load (matches production order) |
| 14 | Unavailable API | Rejection propagates; no backup, no load |
| 15 | Duplicate approval | `already-applying` → `skipped` with zero I/O |
| — | `isDesignChanged` | Identical snapshot → fresh; edited design → stale |

## Mocks vs. real integration

- **Mocked:** the `AgentPort` (`getDesign` / `loadDesign`) — thin `vi.fn()`
  stand-ins returning canned designs and native-shaped results
  (`{ ok, loaded, errors }`). They verify *our decision logic* (order of
  backup vs. load, stale short-circuit, error surfacing), not Unlayer's
  validation.
- **Real:** `prepareParagraphEdit`, `approveEdit`, `isDesignChanged`,
  `escapeHtml` — the exact functions `App.tsx` calls. If production logic
  changes, these tests fail.

## What remains untested (manual QA required)

No browser was launched during M2. Before any demo or release, run the
checklist below against `npm --prefix app run dev` + the Unlayer canvas:

1. Editor loads; status shows the connected agent-enabled editor count.
2. Empty prompt → `Enter replacement text first.`
3. Valid prompt → proposal shown, canvas unchanged.
4. Approve → `Checking…` → `Applying…` → `Approved change applied
   successfully.`; canvas text updates.
5. Edit the canvas mid-proposal → approve → stale message, canvas kept.
6. Discard → `Proposal discarded.`, no canvas change.
7. Refresh → saved design restored; Developer Mode → Save Design Locally
   shows JSON.
8. Payload probe: enter `<img src=x onerror=alert(1)>` as replacement
   text, approve, then inspect Developer Mode JSON — `values.text` must
   contain `&lt;img`, never a live tag.

Also untested: autosave races, `localStorage` quota failure, interrupted
saves, malformed stored designs, StrictMode double-mount listener leaks,
WebMCP tools, multi-editor targeting, and real Unlayer `audit` /
`protectedElements` payloads (the adapter forwards them; no UI renders
them yet — M3/M4).

## Known limitations (documented, out of M2 scope)

- Staleness is still `JSON.stringify` equality (key-order sensitive, O(n)).
  A canonical hash is planned for a later milestone.
- The transform still targets only the first paragraph by fixed path.
- `values.text` matching is substring-based: if the old text also appears
  inside an HTML tag/attribute, replacement could touch markup. The
  escape fix closes *injection*; structural HTML-aware editing is M4 work.
- `errors` from `loadDesign` are joined to a string in the UI; `path`/`code`
  (`invalid_type`, `unknown_type`, `design_changed`, `protected_content`,
  `not_ready`) are preserved in the adapter return but not yet rendered.
- `not_ready` (builder still loading) has no retry; it surfaces as a
  generic failure.

---

# M3 — Agent Change Inspector Foundation

Totals after M3: **43 automated tests** (17 proposal engine + 20 design
 diff + 6 inspector UI), all Node-mode Vitest, plus `tsc -b` and `eslint`
 clean. No new runtime dependencies; suite still runs in well under a
 second.

## How design diffs are calculated (`app/src/engine/designDiff.ts`)

`diffDesigns(before, after)` walks `body.rows → columns → contents`
 (plus `body.headers` / `body.footers` when present) on both snapshots
 and:

1. Indexes content blocks by stable Unlayer `id`.
2. Pairs same-`id` blocks; unpaired ids become `added` / `removed`.
3. Emits `moved` when a paired block changed parent path or index,
   independent of content edits.
4. Compares each paired block's `type` and per-key `values`. Changed
   fields become `modified` ops with readable labels (`Link URL`,
   `Image source`, `Paragraph text`) and truncated before/after strings.
5. **Collapses** a co-occurring `textJson` + HTML `text` change into one
   logical `Paragraph text` op (Lexical JSON is the source of truth; the
   HTML note reads “HTML text updated to match”). Formatting-only and
   unparseable-`textJson` cases degrade to explicit raw-field ops, never
   to silence.
6. Summarizes (`N changes across M blocks`) with per-kind counts.

The diff is **local and structural**: it describes what the proposal
 would change. It is computed at prepare time and stored on the proposal
 (`PreparedParagraphEdit.diff`). It is labeled as such in the UI.

## Which changes are supported

- Paragraph/text edits (collapsed to one logical change).
- Added and removed blocks (id, type, JSON path).
- Property edits on any block type (button `href`, image `src`, …).
- Nested rows/columns and header/footer sections (paths preserved).
- Reorders and cross-column moves (`moved`, with previous location).
- Block type changes on a reused id (`Block type` modified op).
- Sibling blocks are verified untouched (no ops emitted for them).
- Inputs are never mutated; before/after values are truncated display
  strings (140 chars).

## What is uncertain or unsupported (conservative by design)

- Blocks **without stable IDs** are paired by position as a best effort;
  the diff is marked `complete: false` with a `limitations` entry.
- **Duplicate IDs** are paired by order; `complete: false` + limitation.
- Unrecognized structures (non-object designs, missing `body`/`rows`)
  yield **zero changes** + `complete: false`: the engine withholds guesses
  rather than reporting an “added everything” diff against an unreadable
  baseline.
- Non-content settings (`body`/`row`/`column` `values`) are **not
  itemized**; positionally aligned settings are compared and any drift
  sets `complete: false` with a limitation. `counters` are ignored as
  bookkeeping.
- Unparseable `textJson` falls back to raw-field ops + limitation.
- The first-paragraph-only proposal transform is unchanged (manual-test
  scope); the diff engine itself is fully general.

## When native audit results become available

**Only after approval.** `loadDesign` applies valid changes, so it is
 never called to “preview” an audit. The flow is:

1. Prepare → local diff shown, labeled as a structural preview. No native
   contact except the initial `getDesign`.
2. Approve → stale re-check → backup → `loadDesign` → the **full native
   result** (`ok`/`loaded`, `errors[]` with `path`/`message`/`code`,
   `protectedElements`, `audit`) returns.
3. Applied → `NativeResultPanel` (“Last applied change”) shows ok/loaded,
   protected elements, and audit status/issues.
4. Rejected → the proposal stays open; the inspector's alert lists each
   native error with path, message, and code (`invalid_type`,
   `unknown_type`, …). Nothing on the canvas changed.

`approveEdit` now carries the native result on both outcomes
 (`{ status: 'applied' | 'rejected', native }`); `AgentPort.loadDesign`
 uses the full `AgentLoadDesignResult` SDK type.

## How approval and validation interact

- Human approval is still the only gate: no canvas change happens before
  the user clicks Approve.
- Stale-proposal rejection is unchanged (stringify compare, short-circuit
  before backup/load).
- Backup ordering is unchanged (backup → `loadDesign`); tests assert the
  call order via mock invocation order.
- Validation is Unlayer's: the app surfaces native errors/audit, never
  re-implements them.

## M3 manual QA additions (no browser was run for M3)

1. Prepare a valid edit → inspector shows “1 change across 1 block”,
   counts line, one list item (`Paragraph text — Modified …`), and the
   local-preview note; canvas unchanged.
2. Approve → “Approved change applied successfully.” + “Last applied
   change” panel (ok/loaded line, protected elements, audit or
   “Audit unavailable”).
3. Trigger a rejection (e.g. approve after breaking the design another
   way, or approve twice quickly) → joined message in status + structured
   error list with path/code inside the inspector; proposal retained.
4. Stale flow still clears the proposal with the stale message.
5. Payload probe (`<img src=x onerror=alert(1)>`) → inspector shows
   escaped text (`&lt;img`), never a live tag; applied values hold
   `&lt;img`.
6. Resize to 360px width → change list wraps, no horizontal overflow.
7. Tab through Approve/Discard with a screen reader → labels and
   `role="alert"` rejection announced; `aria-label="Design changes"`
   list discoverable.

---

# M4 — Application Policy Guardrails and Integration QA

Totals after M4: **71 automated tests** (19 proposal engine incl. round-trip
 robustness + 20 design diff + 19 policy engine + 5 approval/policy
 integration + 8 inspector UI), all Node-mode Vitest, plus `tsc -b` and
 `eslint` clean. No new runtime dependencies.

Additionally, M4 performed **real browser integration QA** driving the
 live app in system Chrome (headless + CDP, no extra browsers installed):
 agent connection, blank-canvas validation message, seeding, prepare →
 inspector rendering with a real diff, approval → canvas update, native
 result display, HTML-escaping end-to-end (stored design holds `&lt;img`,
 never a live tag), stale-proposal rejection after an external edit, and
 refresh recovery of agent-approved edits (`Saved design restored`).
 See §M4 browser QA below.

## Available rules (`app/src/engine/policies.ts`)

| Rule | ID | Fails on | Advisory? |
|---|---|---|---|
| Allowed link domains | `allowed-link-domains` | Button URL host not in the allowlist | No — FAIL |
| Required disclaimer | `required-disclaimer` | Configured text/block-id absent | No — FAIL |
| Protected sections | `protected-sections` | App-protected block changed, moved, or removed | No — FAIL |
| External link target | `external-link-target` | External button link without `target="_blank"` | Yes — WARN only |

Every result carries `{ ruleId, label, verdict, message, blockIds, paths }`.
 Inputs are never mutated; evaluation is deterministic (no I/O, no dates).
 Each rule is exception-guarded: a bug becomes `UNKNOWN`, never a false
 `PASS`.

## Configuration examples

```ts
import { evaluatePolicies, type PolicyConfig } from './engine/policies';

const config: PolicyConfig = {
  allowedLinkDomains: ['example.com'],   // exact hosts, lowercase-compared; [] = off
  requiredDisclaimer: { text: 'You received this because you subscribed.' },
  // ...or { blockId: 'disclaimer-1' }; either satisfies the rule (OR)
  protectedBlockIds: ['brand-header'],
};
const evaluation = evaluatePolicies({ candidate, original, config });
// evaluation = { results, blocked, complete }
```

The app ships with `DEFAULT_POLICY_CONFIG` (everything off/empty), so
 existing users and the paragraph demo are never blocked: every rule
 passes vacuously and the inspector simply lists the passing checks.

## Policy evaluation lifecycle

1. **Prepare** — `prepareParagraphEdit(original, text, config?)` evaluates
   the candidate immediately and stores `policies` + `policyBlocked` on
   the proposal. The inspector renders the findings as pre-approval
   advice; Approve is disabled while `policyBlocked`.
2. **Approve (recheck)** — `approveEdit` runs an optional `policyGate`
   (`createPolicyGate(config, baseDesign)`) after the stale check and
   **before** any backup or `loadDesign`. A blocked gate returns
   `{ status: 'blocked', policies }` — no backup write, no native call.
   The app refreshes the proposal's findings and shows
   “Blocked by application policy.”
3. **Native validation** — only `loadDesign` (post-approval) produces
   Unlayer errors/audit; those render in the existing rejection/panel UI.

## PASS / WARN / FAIL / UNKNOWN semantics

- `PASS` — the rule verified compliance (or is not configured).
- `WARN` — advisory only (today: external links without `_blank`).
   Visible explanation, approval permitted.
- `FAIL` — the rule was violated (disallowed domain, missing
   disclaimer, changed/moved/removed protected block). Blocks submission.
- `UNKNOWN` — the engine could not verify (missing/relative/non-web
   URL, uninspectable design, corrupt base snapshot, incomplete diff on
   the protected id). **Fail-closed: blocks submission** like FAIL.
   Reported honestly with the reason; resolve the ambiguity to proceed.

Conservative asymmetry is deliberate: allowlist-enforcing rules fail
 closed on ambiguity (“missing or ambiguous URLs never silently PASS”),
 while the advisory rule only reports what it can verify and notes what
 it skipped (relative/non-web links), so ordinary content never blocks
 under the default config.

## Application-policy vs native-audit distinction

- **Application policies** (`policies.ts`): ours, pre-approval, instant,
  local. Labeled in the inspector as “Checked locally before approval —
  separate from Unlayer's native validation and audit.”
- **Native validation/audit** (`loadDesign` result): Unlayer's,
  post-approval only — `ok/loaded`, `errors[]` with `path/message/code`,
  `protectedElements`, `audit`. Never re-implemented, never previewed
  (calling `loadDesign` applies valid changes).

## Unsupported cases and remaining risks

- Subdomain matching is exact-host only (`shop.example.com` ≠
  `example.com`); no wildcard support — document in configs.
- Disclaimer text search covers `text`/`textJson` fields only (paragraph,
  text, heading, button plain text); alt text, menus, and custom blocks
  are not searched — absence there yields FAIL/UNKNOWN as documented.
- Only `button` blocks are link-checked; menu blocks are out of scope.
- Button href object shapes beyond `{ name, values: { href, target } }`
  and plain strings fall back to UNKNOWN (fail-closed).
- Non-content settings drift is still diff-level only (limitation), not a
  policy input.
- `not_ready` still has no retry; stale detection still `JSON.stringify`.
- A serially ambiguous design (duplicate IDs everywhere) yields UNKNOWN
  guidance, which blocks until the design is fixed — intended, but worth
  knowing for template authors.

## M4 browser QA (actually performed, 2026-10-23)

Method: dev server + system Chrome headless driven over CDP with Node's
 built-in WebSocket (no Playwright/Puppeteer download). Fresh profile
 per run (localStorage cleared) except where restoration was tested.

Verified PASS in the live builder:

- Agent connection: “Connected to 1 agent-enabled editor(s).”
- Blank canvas validation: prepare with no paragraph →
  “First content block is not an editable paragraph.”
- Seeded paragraph via `agent.loadDesign` → `ok:true, loaded:true`.
- Prepare → “Proposal ready. The canvas has not been changed.” +
  inspector rendered with a real diff line (kind, block id, JSON path,
  before/after, “HTML text updated to match”).
- Approve → “Approved change applied successfully.” + “Last applied
  change” panel with ok/loaded/audit display.
- Escaping end-to-end: stored `values.text` holds `&lt;img …&gt;`, no live
  tag; `textJson` holds raw text.
- Repeat-edit robustness (new): second prepare on the normalized design
  succeeds (was failing before the escaped-match fix).
- Stale rejection: external `loadDesign` edit → approve → “The design
  changed after this proposal was prepared.”, canvas kept.
- Refresh recovery: reload → “Saved design restored. Autosave ready.”
  with the approved content present.

Findings that changed code (both covered by new unit tests):

1. **Blank templates start with an empty row**, so the first-block
   transform cannot prepare on a fresh canvas (pre-existing workflow
   limit, preserved; QA seeded the paragraph into the empty row).
2. **Post-approval normalization broke re-edits**: Unlayer returns
   `values.text` with normalized wrappers/escapes while `textJson` keeps
   raw text, so the raw-`includes` guard failed closed on every second
   edit of the same block. Fixed by also matching the escaped form
   (preferring raw), with a still-fail-closed fallback — escaping
   guarantee unchanged.
3. Duplicate `loadDesign` of an existing block id is rejected by native
   validation (`ok:false`), observed when a stale prior run's design was
   re-seeded — confirms fail-closed native behavior.

Not covered by browser QA (still manual on a real machine): screen-
 reader pass, 360px responsive check, quota/interrupted-save paths,
 StrictMode remount leaks, WebMCP, multi-editor targeting.

---

# M5 — Real AI Studio

Totals after M5: **111 automated tests** (71 engine/shared + 19 AI
provider/proposal + 13 server + 8 inspector incl. AI rendering), all
Node-mode Vitest, plus `tsc -b` (now also covering `app/server`) and
`eslint` clean. No new runtime dependencies (backend is plain
`node:http`; runs on Node >= 22.18 type stripping).

## What is covered

`app/src/ai/aiProvider.test.ts` — request building, 200/304/501/401/403/
429/400 mapping, `Retry-After` passthrough, hanging-request timeout,
unreachable backend, user cancel vs timeout, invalid-input throws (empty,
oversized, bad mode, oversized design — with zero fetch calls), and a
no-secrets test (same-origin relative URL, no `Authorization` header, no
key-like fields, exact `{instruction, mode, baseDesign}` body shape).

`app/src/ai/aiProposals.test.ts` — valid edit/create proposals, unusable
candidates rejected, empty instructions rejected, no-change detection,
incomplete-diff fail-closed, policy-blocked proposals, stale mid-
generation designs, approval + rejection through the unchanged
`approveEdit`, load-failure passthrough with native codes, blocked-
before-load ordering (no backup, no `loadDesign`).

`app/server/ai-server.test.ts` — request validation (modes, sizes,
shapes), upstream body construction (edit includes `context.fullDesign`,
create omits it), 200/304/401/403/429/5xx mapping, `parseEnvText`,
`loadConfig` defaults/overrides, auth redaction, plus live loopback HTTP
tests: status endpoint (presence-only, no key leakage), 400/501/404
paths, and a full proxied generation with a stubbed upstream (asserts
the `Bearer` wiring and that responses never contain the key).

`ChangeInspector.test.tsx` — AI proposals render "AI instruction
(Edit/Create...)" instead of manual Before/After; diff/policy sections
unchanged.

## Mocks vs real integration

- Mocked: the Unlayer Cloud API (stubbed `fetchImpl` / `fetchFn`) and
  the browser `fetch` to the local backend. The tests verify OUR mapping,
  validation, fail-closed paths, and secret hygiene — not Unlayer's
  models.
- Real: `requestAiGeneration`, `prepareAiProposal`,
  `finalizeAiGeneration`, `approveEdit` wiring, server routing/validation/
  mapping (against a live loopback server), and every engine module they
  compose.
- No test performs a chargeable call: the proxy test with a configured
  key uses a stubbed upstream; validation/short-circuit tests never
  reach the network.

## What still requires a browser or credentials

- **Live AI verification: BLOCKED (no `UNLAYER_API_KEY` in this
  environment).** The mock-mode browser QA below covers the UI states;
  an authenticated end-to-end (real `output.data` -> diff -> approve)
  still needs a keyed run. Do not claim it until a real 200 is observed.
- Screen-reader/360px pass for the new AI controls; quota/rate-limit UX
  against the real API; multi-turn conversation behavior (out of scope).
- Long-generation UX (progress beyond a spinner) and timeout tuning
  against real latencies.

## M5 mock-mode browser QA (performed, no credentials)

Method: dev server + local AI server (no key) + system Chrome headless
driven over CDP with Node's built-in WebSocket (no Playwright).

Verified in the live app shell:

- Status endpoint reachable through the Vite proxy; UI shows the AI
  section with mode radios, instruction box, and Generate button.
- Without a key: backend returns 501 `ai_not_configured`; the app shows
  the not-configured note and manual editing keeps working (prepare ->
  approve -> canvas update unaffected).
- Generate flow with a stubbed 200 upstream is covered by automated
  tests; in the browser without a key the flow correctly stops at
  configuration, never inventing a design.
- No secrets in the client bundle: the provider test plus a bundle grep
  for `UNLAYER_API_KEY` / `unlayer_sk_` (document the command:
  `grep -ri "unlayer_sk_\|UNLAYER_API_KEY" app/dist/assets/*.js`
  must print nothing).

---

# M6 — Developer Lab and Two-Workspace UX

Totals after M6: **144 automated tests** (all previous + inspectBlocks,
adapter schema, tabs, workspace, scenarios, evidence, snippets, API
helpers, LabPage static render), all Node-mode Vitest, plus `tsc -b`
and `eslint` clean. No new runtime dependencies; the editor is never
remounted by workspace switches (single shared instance outside both
workspace sections).

## What is covered

- `designDiff.test.ts` — new `inspectBlocks` suite: block inventory with
  ids/types/paths/value keys, `valuesMissing` flag, and fail-closed
  behavior on uninspectable input.
- `unlayerAgent.test.ts` (new) — adapter passthrough for `describe` /
  `getDesign` against a stubbed global; `getAgentSchema` success path;
  honest `unsupported` error for builders without `schema()`; missing
  agent error. Uses `globalThis` save/restore, no network.
- `WorkspaceTabs.test.tsx` + `workspace.test.ts` — accessible contract
  (both tabs, exactly one `aria-pressed`, `aria-controls` targets) and
  the two-workspace guard.
- `scenarios.test.ts` — all five fixtures assert their required
  outcomes (ready diff shape, stale short-circuit with zero I/O,
  policy-blocked with zero I/O, fail-closed error text, incomplete-diff
  handling), determinism (`runAllScenarios` twice deep-equal),
  no-`unlayer`-global isolation, unknown-id rejection.
- `evidence.test.ts` — id/timestamp assignment and overrides,
  key/token redaction vs prose preservation, export shape (warning,
  generator, entry count, no designs by default), opt-in snapshot
  inclusion with sanitization, scenario mapping.
- `apiExplorer.test.ts` — covers both `snippets.ts` (ids, real
  `unlayer.agent.*` calls, no URLs or secrets) and `apiExplorer.ts`
  (editor formatting, headlines, JSON preview truncation and
  circular-input handling).
- `LabPage.test.tsx` — static render asserts every section heading,
  every action button, and the honesty labels (simulated/mock wording,
  live-only native results, sensitive-content warning, empty states).

## Mocks vs real integration

- Mocked: the agent port inside scenarios (recording stubs asserting
  zero `loadDesign`/backup calls where required) and the global
  `unlayer` in adapter tests.
- Real: `prepareParagraphEdit`, `approveEdit`, `diffDesigns`,
  `inspectBlocks`, `evaluatePolicies`, `createPolicyGate`,
  `getAgentSchema` feature detection, evidence serialization, and the
  LabPage composition itself (static render of production components).

## M6 browser QA (actually performed, system Chrome headless + CDP)

Method: production `vite dev` + system Chrome headless driven over CDP
with Node's built-in WebSocket (no Playwright/Puppeteer download).
Fresh profile per run. Recovery-session runs (2026-10-23) re-verified
the flows below after the interrupted session; earlier-session results
are kept only where re-confirmed.

Workspace + Studio regression (re-verified):

- App loads; agent connects ("Connected to 1 agent-enabled
  editor(s)").
- Seeded paragraph via native `agent.loadDesign` (`ok:true,
  loaded:true`); typed replacement text; Prepare → "Proposal ready.
  The canvas has not been changed."; Approve → "Approved change
  applied successfully."; canvas JSON contains the approved text;
  "Last applied change" native panel renders; switching to the Lab
  shows the same result mirrored as "Last applied change (live)"
  plus an `approve.applied` evidence entry.

Lab flows (re-verified):

- Switch Studio → Lab → Studio: `document.querySelectorAll('iframe')`
  stays at 1 across every switch (no remount, no editor-state loss);
  `hidden` toggles on `#workspace-studio` / `#workspace-lab`; tabs
  expose `aria-pressed` + `aria-controls`.
- API explorer: Check connection renders "Connected to 1
  agent-enabled editor. Schema v28." with `#0 container=…` and
  content types; Load schema renders the Design JSON Schema block;
  Read current design lists blocks with ids and JSON paths
  (seeded `seed-p` block found).
- Scenarios: Run-all shows 5 passes, 0 failures; live canvas design
  JSON length identical before/after (2166 → 2166 bytes) and iframe
  count unchanged — mock isolation holds in the live page (byte
  equality of the full JSON is asserted by unit tests, not the
  browser run).
- Evidence: 5 scenario entries listed; Export evidence JSON reports
  "Exported 5 evidence entries." Export payload shape (warning +
  entries, no design payloads by default, opt-in sanitized snapshot)
  is asserted by `evidence.test.ts`; actual file download to disk was
  not captured in headless mode.
- No credentials in the DOM (`unlayer_sk_` / `UNLAYER_API_KEY`
  absent); responsive: no horizontal overflow (`scrollWidth <=
  innerWidth + 1`; headless minimum width 504px — true 360px
  hardware check still manual).

## Still manual / out of scope

- Screen-reader pass over the Lab (tab order, alert regions).
- Real-Unlayer live replay of fixtures (Lab replays mocks only, by
  design); a live-builder replay toggle is M7 work.
- Evidence persistence across reloads (in-memory, cap 100).
- `preview(device)`, exports, undo controls, and policy playground
  remain future work (see M7 recommendation in the milestone report).

---

# M7A — Release Readiness and Product QA

Totals after M7A: **144 automated tests** (unchanged — M7A added no
production modules, only release hardening), plus `tsc -b` and `eslint`
clean. Product changes in M7A: removed dead `app/src/App.css` (Vite
template leftover, never imported) and added a `:focus-visible` outline
rule for keyboard users. No engine, Lab, server, or behavior changes.

## Method

Recovery run (2026-10-23) after an interrupted session: baseline
re-verified first (144 pass, build + lint clean), then the previous
session's CDP harnesses were reused verbatim (`m7a-qa1/2/2b/dbg.cjs`)
plus two focused follow-ups (`m7a-qa3/4/5.cjs`). Stack: dev server +
system Chrome headless (`--headless=new`, fresh profile per run) driven
over CDP with Node's built-in WebSocket. No Playwright/Puppeteer, no
new dependencies, one Chrome at a time (8 GB RAM discipline). The
one-off harnesses were removed after the run; their results are
recorded here and in `docs/M7A_PROGRESS.md`.

## What the browser proved (all with zero console errors)

- **Workspaces:** Studio ↔ Lab ↔ Studio keeps exactly 1 iframe; the
  canonical (key-sorted) design JSON is identical before/after
  switches; tabs carry `aria-pressed` + `aria-controls`.
- **Proposals:** empty prompt rejected; prepare shows “1 change across
  1 block” with the canvas untouched; approve applies and the canvas
  contains the new text; stale approve after an external edit is
  rejected and the external edit survives; discard clears cleanly.
- **Persistence:** autosave writes the `unlayer-agent-lab:design:v1`
  key with the seeded marker; reload shows “Saved design restored.
  Autosave ready.” with the marker live on the canvas.
- **Explorer:** connection headline + editor list, schema block, and
  block inventory (seeded `seed-p` with JSON path) all render.
- **Scenarios:** 5/5 pass, 0 fail, and the canonical live-canvas JSON
  is byte-identical before/after (3068 = 3068 bytes) — isolation
  verified on normalized content, not just lengths.
- **Evidence export:** the exact downloadable bytes were captured via
  an in-page blob hook: 2051 B, keys `[exportedAt, generator, warning,
  entryCount, entries]`, `entryCount` 5 = 5 entries, no `designs` key
  by default, warning + `unlayer-agent-lab` generator present, sources
  `[simulated]`, zero key-like leaks. Opt-in snapshot adds
  `designs.currentDesign` (6174 B), sanitized, leak-free.
- **XSS probe:** `<img src=x onerror=alert(1)>` as replacement text →
  0 live `img` elements in Studio, no live tag in `innerHTML`; the
  stored `values.text` holds `&lt;img` with no live open tag. Raw text
  survives only inside Lexical `textJson` (by design — the documented
  `textJson` ↔ `text` consistency guarantee), where React renders it
  as text.
- **Responsive:** emulated 360 px viewport — `innerWidth` 360,
  `documentElement.scrollWidth` 360, no horizontal overflow. (Real-device
  hardware check still manual.)
- **Keyboard/a11y:** genuine Tab order is logical (Studio → Lab →
  Developer Mode → textarea → Prepare → AI radios); 10 tabbable
  targets, 0 positive tabindex, 0 unlabeled buttons, 4 live regions,
  solid 2 px `:focus-visible` outline on every stop.
- **AI honesty:** without a key the UI shows the not-configured note
  and Generate stays disabled; manual editing is unaffected.
- **Secrets:** bundle grep for `unlayer_sk_` / `UNLAYER_API_KEY` → 0
  matches; only `app/server/ai-server.ts` reads the key; the browser
  sends same-origin fetches with no `Authorization` header.

## Honestly not verified (unchanged from M6, now gated)

- Live Unlayer Cloud AI generation end-to-end — BLOCKED, no key.
- File download landing on disk in headless mode — Chrome reports
  export success but writes no file (zero `downloadWillBegin` events
  even for a synthetic blob click). Verified the exact bytes instead;
  a real-browser click-and-open is a manual spot-check.
- Screen-reader pass, real-device 360 px, quota/429 UX, multi-turn
  conversation behavior.

---

# M7B — First Authenticated Live AI Generation Test (2026-10-23)

One authorized CREATE request through the production stack (fresh
headless-Chrome profile, real backend with project-scoped key,
Vite proxy, standard 259-char welcome-email prompt). No mocks, no
retries, no second chargeable call.

## Outcome: upstream 403 — plan lacks the AI Assistant feature

- Backend: `generate.start mode=create promptChars=259` →
  `generate.done upstreamStatus=403 mappedStatus=403` in ~4 s.
- Frontend: provider-error message surfaced (“You do not have
  permission to … The AI Assistant feature is not available on this
  project plan.”); **no proposal created** (no diff summary, no
  policy list, no Approve button); canvas canonical JSON identical
  before/after (2231 = 2231 B); AI section correctly showed
  configured state (no “not configured” note, Generate enabled);
  zero console errors.
- Server logs carried statuses/sizes only — no key, prompt, or
  design content.

## Assessment

- **Not an integration bug.** Key accepted (no 401), contract mapping
  behaved exactly as unit-tested (`ai_forbidden` → provider-error,
  fail closed, canvas untouched). No source changes required; suite
  stays 144/144 with `tsc -b` + ESLint clean (re-verified after).
- **Approval flow untested live** (correctly — there was nothing to
  approve). Inspector/policy/approval for AI proposals remain covered
  by unit tests + mock browser QA only.
- **Credits:** the 403 refused before generation; nothing indicates
  spend, but the balance was not queried (no extra calls per policy).
- **Harness note:** the poll loop waited the full ~180 s because the
  terminal 403 message matched none of the expected patterns; the
  server log proves a single upstream call. Future live runs should
  match on the provider-error message family too.

## Still required

A project with the AI Assistant feature enabled, then one CREATE run
through diff → policy → human approval → `loadDesign` (native
validation/audit, visible update, autosave, reload restore).

---

# M8 — BYOM Groq Provider (2026-10-23)

Totals: **178 automated tests** (144 before M8 + 18 `groqOps` engine +
6 `aiProvider` Groq client + 10 `ai-server` Groq backend), plus `tsc -b`
and ESLint clean. No new runtime dependencies. Unlayer Cloud AI
integration untouched.

## What is covered

- `groqOps.test.ts` — inventory (paragraphs only, locked/ID-less/
  unparseable excluded, truncation, caps, uninspectable → `[]`);
  validation (whitelisted type, known IDs, non-empty ≤2000 chars,
  op cap with dropped-reason); application (multi-block, input never
  mutated, HTML/`$`-pattern escaping, normalization-tolerant match,
  fail-closed on unknown/duplicate/locked/broken blocks); proposal
  (ready shape, no-change on empty/identical edits, policy-blocked
  without side effects, incomplete-diff throw); finalizing (stale,
  no-change, provider-error passthrough, unusable output →
  `provider-error`, happy path ready).
- `aiProvider.test.ts` — Groq 200/dropped/model mapping, empty →
  no-change, 501 → not-configured, 401/403/429 codes, unusable-body
  and invalid-input handling with zero fetch calls, same-origin +
  no-`Authorization` + no key-like tokens in the body, `checkGroqStatus`
  shape and failure behavior.
- `ai-server.test.ts` — config defaults/overrides, inventory walk,
  strict-schema request shape (model, temperature 0, `strict: true`,
  inventory in system prompt, no key in body), response mapping (valid,
  empty, all-dropped → `invalid_response`, bad JSON, 401/403/429/400/
  5xx), loopback status/config/validation/501/create-mode/empty-
  inventory/proxy tests with `Bearer` assertion and no key leakage.

## Mocks vs real integration

- Mocked: the Groq HTTP boundary (stubbed `fetchImpl`/`fetchFn`) and
  the agent port in engine tests. Tests verify OUR validation,
  mapping, escaping, and fail-closed ordering — not the model.
- Real: inventory/validation/application/diff/policy/finalize code,
  strict-schema request construction, status mapping, and the App
  provider wiring (browser QA below).
- Exactly ONE free-tier generation call was made (below); validation
  and short-circuit tests never touch the network.

## Live Groq verification (1 call, free tier, 2026-10-23)

Model `openai/gpt-oss-20b` via the real stack (fresh profile, seeded
2-paragraph design, Groq provider selected). Server: `groq.generate
.start model=openai/gpt-oss-20b promptChars=133 blocks=2` →
`groq.generate.done upstreamStatus=200 mappedStatus=200` (~1.9 s).

- “Groq proposal ready. The canvas has not been changed.” with
  **“2 changes across 2 blocks”**, 4/4 policies Passed, Approve
  enabled; canvas canonical JSON identical before/after (4775 B).
- Approve → “Approved change applied successfully.” + “Last applied
  change” native panel; canvas changed (4885 B); autosave key written;
  reload → “Saved design restored. Autosave ready.”
- Zero console errors. Server logs carry statuses/sizes only.

## Still manual / out of scope

- Other `GROQ_MODEL` values (only the default was exercised live).
- Free-tier 429 path against the real API (mapped + unit-tested).
- Non-paragraph blocks, create mode, and conversation memory.
