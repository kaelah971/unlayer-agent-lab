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
