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
