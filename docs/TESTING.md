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
