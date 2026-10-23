# Unlayer Agent Lab — Architecture Plan (Phase 0 Audit)

> Status: **AUDIT ONLY — no behavior was changed.**
> Working tree was clean before and after this audit except for this file.
> This document is the single intended output of Phase 0.
> Date: 2026-10-23. Auditor role: lead engineer. Machine context: Windows laptop, 8 GB RAM.

---

## 1. Current State and Evidence

### 1.1 Repository shape

```
C:\dev\unlayer-agent-lab
├── app/                    # Vite + React + TypeScript application
│   ├── src/
│   │   ├── App.tsx         # ~300 lines — ALL product logic lives here
│   │   ├── App.css         # Vite template leftover — NOT imported (dead code)
│   │   ├── index.css       # Minimal custom styles (~13 lines effective)
│   │   ├── main.tsx        # StrictMode root, imports index.css + App
│   │   └── assets/         # hero.png, react.svg, vite.svg — unused by App
│   ├── index.html          # title "app" (generic), root div, /src/main.tsx
│   ├── package.json        # react 19, react-email-editor 2.1.3, vite 8, TS ~6.0.3
│   ├── vite.config.ts      # default @vitejs/plugin-react, no test runner
│   ├── eslint.config.js    # recommended + react-hooks + react-refresh (not type-aware)
│   ├── tsconfig.app.json   # es2023, bundler, erasableSyntaxOnly, noUnusedLocals
│   └── dist/               # build output (generated, gitignored via app/.gitignore)
└── docs/
    ├── dx-journal.md       # build log + manual verification notes
    └── ARCHITECTURE_PLAN.md # this file (Phase 0 output)
```

Notes:

- There is **no root `package.json`** and **no root `.gitignore`**. The app lives in `app/`. That is fine for now, but any future `packages/engine` split needs an explicit monorepo decision (see §3).
- `git status` at audit start and end: `On branch main, nothing to commit, working tree clean` (before this file). Seven commits, all on `main`, no branches. Commit subjects show a coherent vertical slice history: editor embed → autosave → agent-capable builder → agent detection → human-approved editing → user-controlled text.
- `app/node_modules` is ~123 MB. No test framework, no router, no state library, no CSS framework. This leanness is an asset on an 8 GB laptop — keep it.

### 1.2 What the app actually does today (read from `app/src/App.tsx`)

All references are to the audited `App.tsx` unless stated otherwise.

| # | Capability (as claimed) | Evidence in code | Audit verdict |
|---|---|---|---|
| 1 | Embeds Unlayer Email Builder, agent-capable | `options={{ version: 'latest' }}` on `<EmailEditor>` (`App.tsx` onReady path). `react-email-editor@2.1.3` in `package.json`. | **Implemented. Plausibly working.** `version: 'latest'` is required for the Agent API (docs require builder ≥ 1.519.0; stable pins do not include it). Trade-off: unpinned version = drift risk (see §8 R1). |
| 2 | Automatic agent API detection | `checkAgentConnection()` calls `(unlayer as …).agent.describe()`, counts `details.editors`, sets `agentStatus`. Triggered from `onReady`. | **Implemented.** Correctly uses `describe()` as the presence probe, matching official guidance ("don't check for `unlayer.agent` existence; call `describe()` — it fails when no builder offers the API"). The inline `unlayer as unknown as {…}` casts work but bypass the real types (see §1.4 U2). |
| 3 | Design reading | `agent.getDesign()` in `prepareDemoEdit` and `approveProposal`. | **Implemented.** Matches `AgentApi.getDesign(): Promise<JSONTemplate>`. |
| 4 | Design modification via Agent API | `agent.loadDesign(candidateDesign)` in `approveProposal`; checks `result.ok && result.loaded`, surfaces `result.errors[].message`. | **Implemented.** Correctly uses the **validating** `agent.loadDesign` (returns `{ ok, loaded, errors, errorCount, protectedElements?, audit? }`) rather than the classic callback `editor.loadDesign()` which loads silently. This distinction is the most important correct decision in the file. |
| 5 | Browser-local autosave + restoration | `design:updated` listener → debounced 1000 ms → `editor.saveDesign()` → `localStorage['unlayer-agent-lab:design:v1']`. On boot, parses stored JSON, guards `typeof === 'object' && 'body' in saved`, waits for `design:loaded`, then `loadDesign(saved)`. | **Implemented, partially verified.** Journal reports: design survived reopening days later; edited paragraph triggered autosave and survived refresh. **Not verified in this audit** (no browser run): rapid typing, quota failure, interrupted save, malformed-design recovery, listener cleanup. Debounce + `design:loaded` gating are correct instincts. |
| 6 | User-controlled paragraph replacement | `prepareDemoEdit`: deep-clones via `structuredClone`, navigates `body.rows[0].columns[0].contents[0]`, requires `type === 'paragraph'`, parses `values.textJson` (Lexical `root.children[0].children[0].text`), replaces with textarea content in both `textJson` and `text`. | **Implemented but narrow and brittle by design (manual-test scope).** Only ever touches the first block; throws clearly otherwise. The `before`/`text.includes(before)` guard is a good safety instinct. See §1.4 U3 for the fragility list. |
| 7 | Before/after proposal review | `proposal` state `{ before, after, baseDesign: string, candidateDesign: unknown }`; renders Before/After + Approve/Discard. Canvas untouched until approval (`proposalStatus: 'Proposal ready. The canvas has not been changed.'`). | **Implemented.** This is the seed of the Agent Change Inspector. `baseDesign` as a string snapshot is the stale-check basis. |
| 8 | Human approval + rejection | `approveProposal` (with `approvalInProgress` ref + `isApplying` state double-guard) and Discard button (`setProposal(null)`). Backup write to `localStorage['unlayer-agent-lab:design:pre-approved-edit:v1']` before applying. | **Implemented.** Double-submit guard is correct. Pre-apply backup is good practice. |
| 9 | Stale-proposal rejection | Re-reads `agent.getDesign()`, compares `JSON.stringify(current) !== proposal.baseDesign`; on mismatch discards and tells user to prepare a new proposal. | **Implemented, but the comparison is fragile** (see §1.4 U1). Directionally right; needs a deterministic hash + structural diff. |
| 10 | Developer Mode with JSON inspection | `showDeveloper` toggle; `captureDesign` via `editor.saveDesign` → `setDesign` → `<pre>{JSON.stringify(design, null, 2)}</pre>`. | **Implemented at demo depth.** Manual `saveDesign`-then-view only; no schema view, no `agent.schema()`, no audit view, no export view. |
| 11 | AI generation | Disabled button + "AI generation is not connected yet." | **Correctly NOT claimed.** Honest placeholder. |
| 12 | Export (HTML / text / image / PDF) | Absent from UI. | **Not implemented.** Native APIs exist (`editor.exportHtml`, `agent.exportHtml`, `exportPlainText`, cloud PDF/image). Must use native, not rebuild. |

### 1.3 What the journal verifies (and what it does not)

`docs/dx-journal.md` is a Day-1 DX journal with honest gaps (many sections still template placeholders — that is fine for Phase 0).

Credited verifications (journal-reported, **not re-run in this audit** — no browser was launched, per audit constraints):

- V1: Builder embeds via `react-email-editor@2.1.3`; drag-and-drop Paragraph; text edited to "Hello from Unlayer Agent Lab!" in Chrome at `localhost:5173`. Result: PASS.
- V2: `saveDesign` retrieval (Milestone 2 "Next: test saveDesign" → later done).
- V3: Autosave/restore core workflow PASS (design survived days; paragraph edit survived refresh).
- V4 (Milestone 5, console-JS test): `describe()` + `getDesign()` observed `schemaVersion 28` + paragraph `textJson`; modified copy + local backup; `agent.loadDesign()` returned `ok=true, loaded=true, errorCount=0`; canvas updated without manual editing; autosave reported success afterward. Note: **done in browser console, not via an AI model, and refresh-recovery of agent edits explicitly listed as remaining.**

Explicitly remaining per the journal: rapid typing, failed storage, interrupted saves, malformed design recovery, listener cleanup, refresh recovery of agent edits, reusable React integration, human approval (since implemented after the journal entry — code shows it now exists), error handling, real AI instructions.

**Audit rule applied throughout this plan:** journal PASS marks are treated as *developer-reported manual evidence*, not as regression protection. There are zero automated tests, so every one of them can regress silently today.

### 1.4 Potentially unsafe / fragile / dead (do not ship-expand until addressed)

- **U1 — `JSON.stringify` staleness check.** `approveProposal` compares `JSON.stringify(current) !== proposal.baseDesign`. Key order, whitespace, and counter fields can produce false "changed" (annoying) or, worse, mask real semantic drift in large designs. Cost is also O(n) serialization twice per approval. Replace with a deterministic canonical hash (stable stringify + SHA-256 or FNV-1a for speed) plus a structural diff for the inspector.
- **U2 — Global `unlayer` accessed via ad-hoc casts.** Three separate inline cast types for `agent` (`describe`, `getDesign`, `loadDesign`). The real types already exist in the dependency tree (`@unlayer/types`, transitively via `react-email-editor`): `AgentApi`, `AgentDescription`, `AgentLoadDesignResult`, `JSONTemplate`. Current code compiles but every call site can drift. Also `verbatimModuleSyntax` + `erasableSyntaxOnly` are on — future enum/namespaces will fail; prefer `import type`.
- **U3 — First-paragraph-only transform.** Hard path `rows[0].columns[0].contents[0]`, `text.replace(before, after)` replaces only the **first** occurrence while `textJson` replaces the Lexical node text — the two can diverge if `before` appears twice. No handling of `locked`/permissions beyond a boolean check (good that it checks, but `protectedElements` from `loadDesign` result is ignored). No handling of multi-paragraph, heading, button, or custom tools. Acceptable for a manual-test button; **must not** become the general edit path.
- **U4 — Autosave race + no cleanup.** `saveTimer` lives in the `onReady` closure; never cleared on unmount; `listening` flag prevents re-subscription but there is no `removeEventListener('design:updated')`. `onReady` can fire once per mount; under StrictMode double-mount this is benign today, but after a router split it becomes a leak. Deeper: autosave writes on **every** `design:updated`, including `agent:modified` loads — correct per docs ("your autosave sees it"), but the pre-approved backup key is overwritten unconditionally, and a slow `saveDesign` callback can interleave with an approval read. Needs a revision counter / save queue (see §4).
- **U5 — `localStorage` without versioning or quota strategy.** Keys are namespaced (`unlayer-agent-lab:*` — good). But: no schema-version envelope, no size guard (`QuotaExceededError` is caught generically as "Autosave failed" — acceptable UX, but a 2 MB design on a 5 MB quota with two keys + backup will fail opaquely), no migration path when `schemaVersion` moves off 28. Never store secrets here; today nothing secret is stored — keep it that way.
- **U6 — Ignored `loadDesign` richness.** Code reads `ok/loaded/errors` but drops `protectedElements`, `audit`, `errorCount` semantics, and the `code` field (`invalid_type`, `unknown_type`, `design_changed`, `protected_content`, `not_ready`). The `design_changed` code in particular duplicates the manual stringify check — native can do this job (see §6). `not_ready` (builder still loading) is unhandled and would surface as a generic failure.
- **U7 — Dead code + drift.** `App.css` (Vite template styles with SCSS-like nesting — would not even parse as plain CSS) is never imported. `src/assets/` unused. `index.html` title is "app". `App.tsx` mixes five responsibilities (editor hosting, agent client, proposal state, persistence, dev tools) in one component with six `useState`s + one ref-guard. Every future feature added here increases regression risk geometrically.
- **U8 — Unpinned builder + no contract test.** `version: 'latest'` is *required* for the Agent API today, but it means the design schema, `describe()` shape, and validation codes can change under the app with no failing test. The observed `schemaVersion: 28` should be recorded as a fixture, not assumed.
- **U9 — Accessibility/UX gaps (minor, fix during component split).** Textarea has a label (good). Proposal region uses `role='status'` (good) but Approve/Discard lack `aria-describedby` linkage to the diff; disabled "Generate with AI" button has no explanation for screen readers beyond adjacent text. No error boundary — an Unlayer iframe failure or `JSON.parse` throw outside the try would blank the app.

### 1.5 Configuration notes

- `package.json`: React 19, `react-email-editor 2.1.3`, Vite 8, TS ~6.0.3 (downgraded from 7.x per journal because `typescript-eslint 8.71.2` required TS < 6.1 — documented workaround, do not "fix" by upgrading blindly).
- `tsconfig.app.json`: `es2023` target (so `structuredClone` types are fine), `skipLibCheck: true` (hides `@unlayer/types` mismatches — revisit when importing those types), `noUnusedLocals/Parameters` on (good hygiene).
- `eslint.config.js`: base recommended sets only; **not type-aware** (no `project` wiring). A future `recommendedTypeChecked` pass will surface the `any`-shaped casts — schedule it with the engine extraction, not before.
- No test runner, no router, no e2e. Intentional so far; §7 keeps it that way for the 8 GB constraint (Vitest-node only, no browser farm).

### 1.6 Unlayer official documentation inspected (2026-10-23, via docs site)

Primary source: **`https://docs.unlayer.com/ai/agents`** ("AI Agents" — the Agent API page). Supporting: Load/Save Designs, Export HTML, Cloud API reference index. Key facts incorporated into this plan (all from the official page, corroborated by `@unlayer/types` in `node_modules`):

1. Agent API is **on by default**; opt out per-builder with `agentApi: false`. `unlayer.agent` object itself still exists when opted out — **presence of the object proves nothing; call `describe()`**. The app already does this correctly.
2. Requirements: builder **≥ 1.519.0**; use `version: 'latest'` or pin newer. Stable-without-version lacks the API. The app's `version: 'latest'` is therefore load-bearing, not incidental.
3. Two entry points, same capability: **WebMCP tools** (`unlayer_describe_editor`, `unlayer_get_design_schema`, `unlayer_get_design`, `unlayer_load_design`, `unlayer_preview`, `unlayer_export_html`) for agents that cannot run page JS (Chrome/Edge origin trial; ChatGPT agent browsers; **no Firefox/Safari**), and **`unlayer.agent` JS API** (`describe()`, `schema()`, `getDesign()`, `loadDesign(design)`, `preview(device|null)`, `exportHtml(options)`) which works in every browser. Our app targets the JS API — correct for a developer reference (WebMCP needs origin-trial tokens and is irrelevant to the engine).
4. Canonical agent loop: `describe()` → `getDesign()` → mutate JSON (new blocks need **fresh `id`s**, e.g. `crypto.randomUUID()`) → `loadDesign()` → on `!ok`, fix `errors: [{ path, message, code }]` and retry. Timeouts: 15 s default, 60 s for `getDesign`/`loadDesign`/`exportHtml`; `loadDesign` while loading returns `ok:false, code 'not_ready'` instead of throwing.
5. `loadDesign` semantics (load-bearing for our Change Inspector): **validated first; on failure nothing changes**; success is **one undo step**; success **replaces concurrent changes** (agents must re-read before writing — our stale check mirrors this); **protected content** (locked / non-editable/deletable/movable in live design mode) keeps current values with kept ids listed in `protectedElements`; builder fires **`design:updated` with type `agent:modified`** (so autosave sees agent edits); **audit runs** and is returned inline (`{ status, issues[], issueCount }`); success shape `{ ok:true, loaded:true, errors:[], errorCount:0, protectedElements:[], audit:{…} }`; error `code`s: `invalid_type` (+ format codes), `unknown_type`, `design_changed`, `protected_content` (only when the change *cannot* be applied without touching protected content, or on **duplicate `id`** — note: our engine must mint ids), `not_ready`.
6. Multi-editor: `describe().editors[]` with `{ index, containerId }`; target via last-arg `{ editor: index }`. The app is single-editor today — engine must carry an `editorIndex` field from day one.
7. Discovery affordance: builder iframe gets accessible name "Design editor. AI agents: skip the UI, call `unlayer.agent.describe()`…" — screen-reader-visible, no visual change.
8. Related native surfaces to **use, not rebuild**: `saveDesign`/`loadDesign` (own code), `exportHtml` (+ chunks/body/css/js/fonts), `exportPlainText`, `audit()` + `setValidator`/`setToolValidator`, `undo`/`redo` + `canUndo/canRedo`, `preview` device switching, `schema()` JSON Schema, Cloud API validate/export endpoints for server-side checks later.

---

## 2. Product Architecture

Two experiences, **one engine**. The engine is UI-agnostic and promise-based; each experience is a thin React shell over it.

```
┌──────────────────────────────────────────────────────────────┐
│                        AI Studio (app)                       │
│  Generate → Edit → Inspect → Review → Approve → Export       │
│  (usable email design tool; hides agent mechanics)           │
├──────────────────────────────────────────────────────────────┤
│                       Developer Lab (app)                    │
│  Inspect ops · Diff designs · Test policies · Replay         │
│  scenarios · Copy integration snippets                      │
├──────────────────────────────────────────────────────────────┤
│              Shared UI kit (dumb components)                 │
│  ChangeInspector · DiffView · PolicyBadge · EvidencePanel   │
│  ProposalBar · ExportPanel · ScenarioRunner                 │
├──────────────────────────────────────────────────────────────┤
│              ★ Shared Engine (pure TS, no React) ★          │
│  UnlayerAgentAdapter · DesignStore · ProposalManager        │
│  DiffEngine · PolicyEngine · EvidenceLog · ScenarioRunner   │
├──────────────────────────────────────────────────────────────┤
│              Unlayer native (NEVER reimplemented)            │
│  agent.describe/schema/getDesign/loadDesign/preview/        │
│  exportHtml · editor.saveDesign/loadDesign/exportHtml/      │
│  exportPlainText/audit/undo/redo/design:updated             │
└──────────────────────────────────────────────────────────────┘
```

Routing (deferred to M7; today everything is one page):

- `/studio` — AI Studio. Default landing. Prompt box, proposal bar, canvas, export.
- `/lab` — Developer Lab. Operation inspector, JSON + diff tabs, policy playground, scenario list, integration code snippets.
- Shared layout with experience switcher; deep-linkable proposal/scenario ids for bug reports.

Why this layering:

- The differentiator (Change Inspector with approval, diff explanations, policies, conflicts, evidence) is **all in the engine + shared kit**, so both experiences exercise the same code path. A policy bug fixed for Lab is fixed for Studio.
- Unlayer owns rendering, validation, and HTML generation. We own **decision support around** `loadDesign`: what changed, is it safe, who approved it, what proves it.
- Pure-TS engine ⇒ unit-testable on a weak laptop with plain Vitest-node, no browser, no Docker (see §7).

---

## 3. Component / Module Boundaries

Proposed `app/src/` layout (single-package first; extract to `packages/` only when a second consumer exists):

```
src/
  engine/                      # ★ pure TS — zero react imports
    types.ts                   # Proposal, PolicyResult, DiffOp, EvidenceEvent, Scenario
    unlayerAgent.ts            # UnlayerAgentAdapter (typed wrapper over unlayer.agent)
    designStore.ts             # canonical hash, revision counter, persistence envelope
    proposals.ts               # ProposalManager state machine (idle→…→applied|stale|failed)
    diff.ts                    # design diff → DiffOp[] + human explanations
    policies.ts                # PolicyEngine (brand/links/a11y/size/protected rules)
    evidence.ts                # EvidenceLog (append-only, exportable JSON)
    scenarios.ts               # ScenarioRunner (fixture in → ops out, deterministic)
    index.ts                   # public engine surface only
  unlayer/
    EditorHost.tsx              # owns <EmailEditor>, onReady, event wiring, cleanup
    useAgent.ts                 # describe()/capability hook (editors[], schemaVersion)
  studio/
    StudioPage.tsx              # prompt → proposal bar → canvas → export
    ProposalBar.tsx             # before/after + Approve/Discard + stale notice
  lab/
    LabPage.tsx                 # tabs: Operations | Diff | Policies | Scenarios | Snippets
    OperationInspector.tsx      # describe/getDesign/loadDesign/preview/exportHtml runner
    DiffView.tsx                # side-by-side + op list (uses DiffOp[])
    PolicyPlayground.tsx        # toggle rules, run against candidate design
    ScenarioList.tsx            # replay buttons + expected/actual + evidence link
  shared/
    ChangeInspector.tsx         # THE differentiator UI (proposal + diff + policies + evidence)
    EvidencePanel.tsx           # append-only log view + "copy bug report" button
    ExportPanel.tsx             # exportHtml/plainText/zip/pdf via native, with audit display
    ErrorBoundary.tsx           # per-panel boundaries (editor crash ≠ app crash)
  App.tsx                       # router + providers only (logic moves out)
```

Dependency rules (enforced by review, later by eslint `no-restricted-imports`):

1. `engine/` imports **nothing** from `unlayer/`, `studio/`, `lab/`, `shared/`, or `react`. It receives an `AgentPort` interface (implemented by `unlayerAgent.ts`), so tests inject a mock.
2. `shared/` may import `engine/` types + pure helpers only — never `unlayer` directly.
3. `studio/` and `lab/` compose `shared/` + `engine/` + `unlayer/` hooks; they never talk to each other.
4. All Unlayer contact goes through `unlayerAgent.ts` + `EditorHost.tsx`. No other file touches the global.

---

## 4. Shared Engine Design

### 4.1 Core types (sketch — to be finalized in M1)

```ts
import type { JSONTemplate, AgentLoadDesignResult } from '@unlayer/types';

type EditorRef = { editor: number };            // multi-editor index, default 0
type DesignSnapshot = {
  revision: number;                             // monotonic, engine-owned
  hash: string;                                 // canonical-hash(design)
  design: JSONTemplate;                         // structuredClone at capture
  capturedAt: string;                           // ISO timestamp
  schemaVersion?: number;
};
type Proposal = {
  id: string;                                   // crypto.randomUUID()
  base: DesignSnapshot;                         // what the agent saw
  candidate: JSONTemplate;                      // what it proposes
  diff: DiffOp[];                               // engine-computed, human-readable
  policies: PolicyResult[];                     // engine-computed
  status: 'proposed'|'checking'|'approved'|'applied'|'discarded'|'stale'|'failed';
  evidence: string[];                           // EvidenceLog event ids
};
type PolicyResult = { rule: string; verdict: 'pass'|'warn'|'fail'; detail: string; path?: string };
type DiffOp = { kind: 'add'|'remove'|'replace'|'move'; path: string; before?: unknown; after?: unknown; summary: string };
```

### 4.2 Modules and responsibilities

- **`UnlayerAgentAdapter`** — typed promise wrapper over `unlayer.agent` (+ classic `editor.*` where the agent API has no equivalent: `saveDesign` callback, `undo/redo`, `audit()`). Normalizes errors (timeout vs `not_ready` vs validation), injects `{ editor }` targeting, enforces call timeouts (15 s / 60 s per docs). Only place that knows the global exists.
- **`DesignStore`** — canonical snapshot source. `capture()` → deep-clone + stable-hash + `revision++`. Persistence envelope `{ v: 1, revision, hash, schemaVersion, savedAt, design }` under versioned keys; quota-aware write (catch `QuotaExceededError` → evict backup key first, then report). Emits `revision` with every autosave so approvals can compare integers, not strings.
- **`ProposalManager`** — state machine. `prepare(base, candidate)` runs diff + policies synchronously (fast, local) before touching the canvas. `approve(id)` re-reads live design, compares **revision + hash** (fast path) with `design_changed` from native as backstop, writes pre-apply backup, calls `loadDesign`, records `protectedElements` + `audit` into evidence, transitions to `applied` or `stale`/`failed` with structured reason codes (never bare strings).
- **`DiffEngine`** — JSON diff over `JSONTemplate` constrained to the design grammar (rows → columns → contents → values). Produces `DiffOp[]` with path strings matching native error `path`s so inspector rows and native errors join visually. Summaries in plain language ("Paragraph 1 text: 'Hello' → 'Sale starts Friday'"). Bounded output (cap ops, truncate long strings) to protect the `<pre>` panel and 8 GB RAM.
- **`PolicyEngine`** — synchronous, composable rules returning `PolicyResult[]`. Starter set: `no-empty-links` (buttons/menus need href), `img-alt-present`, `protected-content-untouched` (cross-check candidate vs base on locked subtrees), `size-budget` (warn > 1 MB design JSON), `merge-tag-shape` (values match `{{name}}` allowlist from `describe().mergeTags`), `custom-tool-allowlist` (reject `unknown_type` early using `describe().contentTypes`). Policies **advise**; only `fail` rules block approval, and the block list is user-visible and toggleable in Lab.
- **`EvidenceLog`** — append-only ring (cap e.g. 500 events): `{ t, kind, proposalId?, revision?, detail, data? }`. Kinds: `describe`, `get`, `propose`, `policy`, `approve-check`, `load-result`, `autosave`, `restore`, `error`. One-click export (JSON download + clipboard) for bug reports. This log **is** the debugging-evidence differentiator.
- **`ScenarioRunner`** — deterministic replay: fixture `{ name, baseDesign, editScript, expect: { diff, policies, loadResult } }` → runs `proposals.prepare` + `policies.run` + mock `loadDesign` → returns pass/fail + evidence slice. Powers Lab's "replay editing scenarios" and the regression suite (see §7).

### 4.3 Key algorithms

- **Canonical hash:** stable-stringify (sorted keys, recursive; arrays order-preserving) → FNV-1a 32-bit for in-memory revision checks (fast) + SHA-256 (via `crypto.subtle`, async) for persisted envelope integrity. Store both; compare FNV first.
- **Stale detection (three layers):** (1) engine `revision` integer compare — instant; (2) FNV hash compare — catches out-of-band writes that bypassed the store; (3) native `design_changed` / `protected_content` codes from `loadDesign` as final arbiter. Never rely on raw `JSON.stringify` equality.
- **Id minting:** every engine-created block gets `` `${slug}-${crypto.randomUUID().slice(0,8)}` `` (per official guide) and the engine pre-scans candidate ids against base ids to avoid `protected_content`-by-duplicate-id.
- **Autosave queue:** single-flight `saveDesign` with `pendingDirty` flag; `design:updated` sets dirty, worker saves, reads back revision. Agent-originated updates (`agent:modified`) bump revision identically — no special-casing, so approval reads always see a monotonic number.

---

## 5. Data Flow

### 5.1 Happy path: propose → approve → applied

```
User/AI edit intent
  │  (Studio prompt box OR Lab op runner OR scenario script)
  ▼
UnlayerAgentAdapter.getDesign() ──► DesignStore.capture() [revision R, hash H]
  │  deep-clone → transform (engine fn, NOT inline JSX) → candidate
  ▼
ProposalManager.prepare(base{R,H}, candidate)
  │  ├─ DiffEngine.diff(base, candidate) → DiffOp[] + summaries
  │  └─ PolicyEngine.run(candidate, ctx{mergeTags, contentTypes}) → PolicyResult[]
  ▼
ChangeInspector shows: before/after · diff ops · policy badges · evidence link
  │  canvas UNTOUCHED (requirement preserved from current app)
  ▼
User clicks Approve
  │
  ├─ ProposalManager.approve(id):
  │    live = getDesign() → liveRevision/liveHash
  │    liveRevision !== R or liveHash !== H ──► status=stale, discard candidate, keep evidence
  │    else: backup(base) → agent.loadDesign(candidate)
  │      ├─ !ok ──► status=failed + native errors (path/message/code) + audit into evidence
  │      └─ ok ──► status=applied + protectedElements + audit into evidence
  ▼
design:updated(agent:modified) ──► autosave queue ──► DesignStore revision R+1, persist envelope
```

### 5.2 Conflict / failure paths

- **Concurrent canvas edit during review:** revision bump → approval short-circuits to `stale` without calling `loadDesign`. No canvas change, no data loss. Inspector offers "Rebase proposal onto current design" (M5+; diff re-run against new base).
- **Native validation failure:** `errors[]` rendered inline on the matching `DiffOp` rows by `path`; `code` drives the hint (`unknown_type` → "turn on this tool or remove the block"; `protected_content` → "duplicate id or locked content"; `not_ready` → auto-retry once after ready poll).
- **Protected content:** `protectedElements[]` listed as warnings, not errors; Lab shows which template lock caused each.
- **Storage failure:** quota error → keep in-memory revision, banner "Autosave paused — export your design", offer one-click JSON download. Never silently drop.

---

## 6. Native vs. Application Capabilities

Principle: **if Unlayer returns it, render it — don't recompute it.**

| Capability | Owner | Rationale |
|---|---|---|
| Render canvas, drag-drop, property panels | **Native** (`<EmailEditor>`) | Core builder value; duplicating is out of scope. |
| `describe()` capability probe + guide | **Native**; engine caches result | App must not hardcode content types/fonts/merge tags. |
| `schema()` JSON Schema | **Native**; Lab displays + links it | Future: validate candidates locally with the fetched schema before `loadDesign`. |
| `getDesign()` / `agent.loadDesign()` validation | **Native** | Validating loader with `errors[]`, `protectedElements`, `audit` is the platform's job. App surfaces all three (currently surfaces only messages). |
| `exportHtml` / `exportPlainText` / image / PDF / ZIP | **Native** (`agent.exportHtml` + classic callbacks; cloud for PDF/image) | App provides ExportPanel wiring + audit display, never its own HTML serializer. |
| `audit()` + `setValidator` / tool validators | **Native** runs checks; app supplies **custom policy validators** via `setValidator` and renders results | Our PolicyEngine is pre-flight advice; `audit` is post-load ground truth. Show both, label them. |
| `undo`/`redo`, `canUndo/canRedo` | **Native** | Agent loads are one undo step — Inspector offers "Undo applied change" via native `undo()`, not via re-loading old JSON. |
| `preview(device)` | **Native** | Agent "check its work in a screenshot" flow; Lab exposes device buttons. |
| `design:updated` / `design:loaded` events | **Native** | Engine subscribes; distinguishes `agent:modified` for evidence labeling. |
| Proposal capture, before/after, approve/discard, stale rejection | **App (engine)** | Human-approval workflow is our product, not Unlayer's. |
| Design diff + plain-language explanations | **App (DiffEngine)** | Native returns error paths, not user-facing change summaries. |
| Policy checks (brand/links/a11y/budget) | **App (PolicyEngine)** + optionally registered as native `validator` | Pre-flight gates with Lab-tunable rules. |
| Conflict detection (revision/hash + rebase UX) | **App**, with native `design_changed` as backstop | Native detects at load time; we prevent the futile load and explain it. |
| Evidence log + bug-report export | **App (EvidenceLog)** | Nothing native persists the decision trail. |
| Scenario fixtures + replay | **App (ScenarioRunner)** | Developer-education surface; runs against mock or live adapter. |
| Autosave + restore envelope | **App (DesignStore)** on top of native `saveDesign`/`loadDesign` | Versioning, hashing, quota handling are app concerns. |
| AI text generation itself | **External (later)** | Engine accepts candidate designs from any producer (prompt box, script, future LLM endpoint). Never build an LLM client into the reference app until the engine contract is stable. |

---

## 7. Milestone Plan (small, testable, ordered)

Each milestone is sized for one focused session on the 8 GB laptop. **No milestone changes Unlayer versions or adds heavy deps.** Acceptance criteria are checkable without a browser farm (browser steps are manual + scripted).

- **M0 — Phase 0 audit (this document). DONE.**
  - Accept: `docs/ARCHITECTURE_PLAN.md` exists; `git status` clean apart from it; no `app/` file modified. ✅ (this file)

- **M1 — Engine skeleton + typed adapter (no behavior change).**
  - Create `app/src/engine/types.ts` (Proposal/PolicyResult/DiffOp/EvidenceEvent per §4.1) using `import type { JSONTemplate, AgentLoadDesignResult } from '@unlayer/types'`; create `app/src/engine/unlayerAgent.ts` wrapping `describe/getDesign/loadDesign/exportHtml/preview` with timeouts + `{ editor }` targeting; rewire `App.tsx` call sites to the adapter with identical UX.
  - Accept: `npm run build` + `npm run lint` pass; manual checklist (describe count, prepare, approve, discard, stale, refresh-restore) all still PASS; `git diff --stat` shows only the adapter + rewired imports.

- **M2 — Deterministic identity: hash + revision replace stringify.**
  - Add `designStore.ts` (canonical hash FNV-1a + SHA-256 envelope, revision counter, versioned localStorage keys, quota-aware write); replace `JSON.stringify` compare with revision+hash; record observed `schemaVersion` 28 as a constant + fixture.
  - Accept: unit-testable pure functions (see §8 test plan) — but since no runner exists yet, accept via a temporary `npm run build` + manual stale test: edit canvas mid-proposal → approval reports stale; no false stale on identical re-read.

- **M3 — ChangeInspector extraction (the differentiator, v1).**
  - Extract `ChangeInspector.tsx` (proposal + diff-op list + policy badges + evidence excerpt) and `ProposalBar.tsx`; `App.tsx` becomes composition only. Surface native `audit` + `protectedElements` in the inspector (currently dropped). Add per-panel `ErrorBoundary`.
  - Accept: pixel-equivalent Studio flow; inspector shows audit status + protected list on an applied change; editor crash simulation (invalid fixture via Lab, M4) no longer blanks the page.

- **M4 — PolicyEngine + Lab Operations tab.**
  - Implement starter rules (§4.2) + `PolicyPlayground`; add `/lab` route (lazy-loaded) with Operations runner (describe/schema/get/load/preview/export) and JSON viewer. Register strictest rule as native `setValidator` demo.
  - Accept: each rule has a fixture proving pass + fail; Lab can load an invalid fixture and display native `errors[]` joined to diff paths; Studio approval blocked only by `fail` rules with visible reason.

- **M5 — ExportPanel + undo-of-applied-change.**
  - Wire `exportHtml`/`exportPlainText` (+ download), show `audit` on export, add "Undo applied change" via native `undo()` gated by `canUndo`.
  - Accept: exported HTML contains approved text; audit FAIL demo (e.g. image without alt) surfaces with element path; undo restores pre-approval canvas and logs evidence.

- **M6 — ScenarioRunner + fixtures (replayable editing scenarios).**
  - Ship 5 fixtures: paragraph-replace happy path, stale-proposal conflict, protected-content keep, unknown-tool rejection, duplicate-id rejection. Lab replays each against mock adapter + optionally live builder; evidence slice downloadable per run.
  - Accept: all 5 pass on mock; live-builder replay passes for happy-path + stale; fixtures committed under `app/src/engine/__fixtures__/`.

- **M7 — Studio/Lab split + docs.**
  - Router (`/studio`, `/lab`), shared layout + experience switcher, lazy Lab bundle, `index.html` title + meta, remove dead `App.css`/unused assets, README quickstart + architecture pointer.
  - Accept: Lab chunk lazy-loads (network panel shows separate chunk); cold `npm run dev` on the 8 GB laptop responsive (< ~10 s to interactive on repeat run); README documents the engine import path for external integrators.

Out of scope for these milestones (explicitly deferred): real LLM generation endpoint, server persistence, multi-user collab, WebMCP origin-trial setup, custom Unlayer tools, Cloud API validate/export integration (design the `AgentPort` interface so a server-backed adapter fits later without engine changes).

---

## 8. Testing Strategy

Today: **zero automated tests** — the biggest process risk. Strategy is constrained by the 8 GB laptop: **no Docker, no browser farm, no memory-heavy e2e in the inner loop.** Three layers:

**Layer 1 — Pure unit tests (new, Vitest-node only).**
Add `vitest` (dev-only, ~few MB, runs in-process) — the single allowed test dep. Target the engine's pure surface, which needs no browser:

- `diff.test.ts`: paragraph replace, block add/remove/move, id-duplicate detection, path format matches native `errors[].path` grammar; output bounded (cap ops).
- `policies.test.ts`: each rule gets pass + fail fixtures (empty link, missing alt, locked-subtree touch, oversize design, bad merge tag, unknown tool).
- `hash/store.test.ts`: canonicalization (key-order invariance), revision monotonicity, envelope migration v0→v1, quota-failure fallback.
- `proposals.test.ts`: state machine transitions incl. stale short-circuit, double-approve guard, `not_ready` retry-once.
- `scenarios.test.ts`: the 5 M6 fixtures as regression tests with a mock `AgentPort` (records calls, replays canned `loadDesign` results incl. each native `code`).

Acceptance per test file: deterministic (no timers, no network), < 1 s each on the laptop, runnable via `npm run test -- --run` (watch mode off by default to save RAM).

**Layer 2 — Contract tests against the typed adapter (mocked `unlayer`).**
`unlayerAgent.test.ts` with a fake global exercising: `describe()` failure when no editors (opt-out case), 60 s vs 15 s timeouts, `{ editor: 1 }` targeting passthrough, error normalization (`not_ready` → retryable, others → terminal). No iframe needed.

**Layer 3 — Manual browser checklist (preserved and extended, not replaced).**
Keep the journal's manual style but script it: `docs/MANUAL_CHECKLIST.md` (M1) with steps for describe-count, prepare/approve/discard/stale/refresh-restore/export/undo, each with expected status strings. Run before every milestone merge. Optional later: single Playwright spec for the happy path only, explicitly **not** in the default loop (Chromium + Vite + builder will pressure 8 GB).

Evidence discipline: every manual run appends timestamped results to `docs/dx-journal.md` (existing habit — keep it); every automated failure must include the EvidenceLog slice format so Lab replays and CI failures look identical.

---

## 9. Performance Assessment (Windows laptop, 8 GB RAM)

Measured/known baselines: `node_modules` 123 MB; Vite 8 + React 19 + single Unlayer iframe is a **light** workload — dev server typically 300–500 MB RSS, Chrome with builder iframe 500 MB–1 GB, leaving headroom provided nothing else heavy runs alongside.

- **Editor + iframe:** one builder instance is fine. Do **not** mount Studio and Lab editors simultaneously (M7 lazy route keeps one alive at a time). `preview(device)` screenshots are native-side; no canvas cost in our process.
- **Design JSON costs:** the observed design is small (single paragraph, `schemaVersion 28`), but real templates reach 1–5 MB. Current code `JSON.stringify`s the full design on every approval check and `structuredClone`s it per proposal — both O(n) and doubling peak memory transiently. Mitigations (M2): FNV hash for comparisons, clone-once per proposal, cap `DiffOp` output, virtualize or truncate the `<pre>` JSON view (rendering 5 MB into a `<pre>` will jank any laptop — paginate or collapse subtrees).
- **Autosave:** 1 s debounce is correct; keep single-flight saves and skip when `!dirty`. `localStorage` quota (~5 MB) fits one design + one backup but not history — hence ring-buffer evidence (no design copies in the log, only hashes) and one-click file download instead of unbounded key growth.
- **Build/test loop:** `tsc -b` + Vite build is seconds-scale today; Vitest-node adds negligible RAM. Forbidden-for-now: Docker Desktop (GBs idle), full Playwright matrix, `type-checked` lint across the codebase in watch mode — run those scoped, not global.
- **Budget targets (M7 exit):** cold `npm run dev` → interactive < 10 s repeat; production bundle (Studio initial) < 300 kB gzip excluding Unlayer CDN/iframe; approval path (hash + diff + policies on a 1 MB design) < 200 ms on i5-class CPU; no full-design `JSON.stringify` on the keystroke path.

---

## 10. Risks and Mitigations (top 5)

**R1 — Unpinned builder `version: 'latest'` silently changes validation, schema, or `describe()` shape.**
*Impact:* High — proposals that pass today fail tomorrow with no code change; `schemaVersion` drift breaks fixtures. *Mitigation:* record observed version + `schemaVersion` 28 in evidence on every `describe()`; add a contract test asserting the fields we depend on (`editors`, `contentTypes`, `mergeTags`, result codes); pin to a known-good version the moment one is validated, and document the pin policy in README. *Owner:* M1/M2.

**R2 — Stale/conflict logic is string-equality on full JSON — false staleness or missed conflicts under concurrent edits.**
*Impact:* High — users either cannot approve valid proposals (annoyance → workaround → bypassed review) or overwrite a colleague's canvas edit (data loss). *Mitigation:* M2's revision+hash triple layer (§4.3) with native `design_changed` as arbiter; add the "rebase proposal" UX in M5 so conflicts are recoverable, not dead ends.

**R3 — Autosave and approval race; backup key overwritten unconditionally.**
*Impact:* Medium-High — a slow `saveDesign` interleaved with `loadDesign` can persist a half-applied state as "the" design; the pre-approval backup may already contain the candidate when the user needs to roll back. *Mitigation:* single-flight save queue + revision tagging (M2); backup write happens **after** the stale re-check and **before** `loadDesign`, keyed by `proposalId` (`:pre-approved-edit:<proposalId>`), retained until applied/undone.

**R4 — Validation richness ignored: `audit`, `protectedElements`, error `code`s dropped; only message strings shown.**
*Impact:* Medium — silently ships designs with missing alt text / empty links / kept-protected substitutions the user never sees; `duplicate-id` and `not_ready` failures present as generic errors. *Mitigation:* M3 inspector surfaces all three native payloads; M4 policy rules pre-empt the common codes; `not_ready` gets one automatic retry. No extra Unlayer calls needed — the data is already returned.

**R5 — God-component + zero tests + global casts = every edit risks silent regression of manually-verified flows.**
*Impact:* Medium (grows with each feature) — the seven manually-verified behaviors have no executable guard. *Mitigation:* strict module boundaries (§3) with the engine React-free so Vitest covers it cheaply (M1–M2 first tests: hash + state machine); adapter centralizes the global (M1); `App.tsx` shrinks to composition by M3; manual checklist becomes a committed doc run per milestone until automation covers it.

*Honorable mentions (tracked, not top-5):* `text.replace` first-occurrence divergence (U3 — fix inside DiffEngine transform fns); `App.css` dead code confusing contributors (delete in M7); `index.html` title "app" (M7); no error boundaries (M3); localStorage-only persistence limits multi-device (deferred — engine `DesignStore` gets a storage-port interface so a server adapter fits later).

---

## 11. Immediate Next Implementation Task (do NOT start during Phase 0)

**M1, step 1 only — `engine/types.ts` + `engine/unlayerAgent.ts` + rewire, zero UX change.**

1. Create `app/src/engine/types.ts` with the §4.1 types, importing `JSONTemplate` / `AgentLoadDesignResult` / `AgentDescription` as `import type` from `@unlayer/types` (already present transitively — no new dependency).
2. Create `app/src/engine/unlayerAgent.ts`: `createAgentAdapter({ timeoutMs })` exposing `describe/getDesign/loadDesign/exportHtml/preview` with `{ editor }` passthrough, 15 s / 60 s timeouts, and normalized error kinds (`NoEditors`, `Timeout`, `NotReady`, `Validation`). No React in this file.
3. Rewire the three inline `(unlayer as …)` casts in `App.tsx` to the adapter. No status-string changes, no new UI.
4. Record builder version + `schemaVersion` into `agentStatus` evidence (display string unchanged).

Acceptance: `npm run build` ✅, `npm run lint` ✅, manual checklist (describe count → prepare → approve → discard → stale → refresh restore) all PASS with identical UX, `git diff --stat` confined to `app/src/engine/` + `App.tsx` import/call-site lines. Then commit as `refactor: extract typed agent adapter (no behavior change)`.

Explicitly **not** in this task: hashing changes, UI extraction, policies, tests, version pins,exports. Those are M2+.

---

## Appendix A — Files inspected

- `app/package.json`, `app/package-lock.json` (spot: `react-email-editor` 2.1.3 → `@unlayer/types` presence)
- `app/src/App.tsx` (full, 300 lines — sole logic file)
- `app/src/App.css` (full — dead, Vite-template nesting, unimported)
- `app/src/index.css`, `app/src/main.tsx`, `app/index.html`, `app/vite.config.ts`, `app/eslint.config.js`, `app/tsconfig*.json`, `app/.gitignore`
- `docs/dx-journal.md` (full — verification history + remaining-tests list)
- `app/node_modules/react-email-editor/dist/index.d.ts` (global `unlayer: UnlayerEmbed` declaration)
- `app/node_modules/@unlayer/types/dist/{editor/editor.d.ts, editor/design.d.ts, editor/export.d.ts, editor/audit.d.ts, design.d.ts}` (AgentApi, AgentLoadDesignResult, JSONTemplate, Export*, Audit/Validator)
- `https://docs.unlayer.com/ai/agents` (Agent API: requirements, WebMCP vs JS, loop, loadDesign semantics, codes, multi-editor, opt-out), plus Load/Save + Export HTML pages
- `git log --stat`, `git show`, `git status`, `git branch -a`

## Appendix B — Files changed

- `docs/ARCHITECTURE_PLAN.md` — **created (this file). The only intended output.**
- Accidental `curl` download artifact in repo root — **removed immediately**; `git status` verified clean otherwise.
- No application source, config, version, dependency, or user-data file was modified, installed, committed, pushed, deployed, or deleted.

## Appendix C — Doc pointers for implementers

- Agent API: `https://docs.unlayer.com/ai/agents`
- Load/Save: `https://docs.unlayer.com/builder/load-and-save-designs`
- Export HTML: `https://docs.unlayer.com/builder/export-html`
- Design schema & validate/export endpoints: Cloud API reference (`reference/design-schema` path serves the API index — use the docs search for "Get the design JSON Schema" / "Validate a design")
- In-repo types: `app/node_modules/@unlayer/types/dist/` (read-only reference until M1 imports them as `import type`)
