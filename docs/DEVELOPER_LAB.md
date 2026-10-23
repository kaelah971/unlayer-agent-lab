# Developer Lab (M6)

The integration playground of Unlayer Agent Lab. Where AI Studio hides
agent mechanics behind a usable product, the Lab exposes them: live
agent operations, structural diffs, deterministic scenario replays, and
exportable debugging evidence — all running on the same shared engine,
never duplicated.

## Workspace architecture

One page, two workspaces, one editor:

- Tabs (`AI Studio` / `Developer Lab`) are plain React state — no router
  library. Switching toggles `hidden` on the workspace sections.
- The Unlayer `<EmailEditor>` instance lives **outside** both workspace
  sections, so it is never remounted: switching workspaces cannot drop
  editor state, break autosave, or lose the canvas.
- Tab state also drives no data fetching by itself; the Lab fetches only
  when you click a button (keeps startup light on 8 GB RAM).
- All shared rendering (`DiffView`, `PolicyList`, `NativeResultPanel`,
  `InspectorErrorBoundary`) is reused verbatim between Studio and Lab.

Related code: `app/src/lab/workspace.ts`, `app/src/shared/WorkspaceTabs.tsx`,
`app/src/App.tsx` (composition + evidence log state).

## API explorer

Three read-only operations, each behind an explicit button:

| Button | Native call | Shows |
|---|---|---|
| Check connection | `agent.describe()` | Editor count, per-editor index/container, content types, schema version; failures as plain errors |
| Load schema | `agent.schema()` | Truncated JSON Schema in a `<details>` block, or an honest "unsupported" message when the builder predates the API |
| Read current design | `agent.getDesign()` | Block inventory (id, type, JSON path, value fields), inspection limitations, raw JSON in a collapsible block |

Nothing here writes: no `loadDesign`, no canvas edits, no storage writes.
Reads are recorded in the evidence log (live source, outcome only — never
full designs by default). Pure formatting lives in
`app/src/lab/apiExplorer.ts` (`formatEditorList`, `connectionHeadline`,
`previewJson` with byte counts and truncation flags).

## Scenario runner

Five deterministic fixtures (`app/src/lab/scenarios.ts`), each executed
against the **real production modules** (`prepareParagraphEdit`,
`approveEdit`, `diffDesigns`, `evaluatePolicies`, `createPolicyGate`)
with recording mock ports:

1. `paragraph-replace` — a valid first-paragraph edit prepares cleanly
   (one collapsed diff change, policies pass).
2. `stale-rejection` — approval after an external canvas change stops
   before backup/`loadDesign` with a stale outcome.
3. `protected-change` — editing an application-protected block fails the
   policy gate; nothing is backed up or loaded.
4. `unsupported-content` — an image-first block fails closed with the
   expected "not an editable paragraph" error.
5. `duplicate-ids` — a diff over duplicated IDs reports the ambiguity
   (`complete: false` + limitation) instead of guessing.

Each run records `loadDesign`/`backup` call counts to prove the isolation
claim, and every run is labeled, in the UI and in the evidence:

> Simulated with a mock agent port. The live canvas, autosave, and editor
> session are untouched — this is not proof the live SDK would accept the
> design.

`runAllScenarios()` is deterministic (same input → byte-identical
output; covered by an automated test).

## Simulation vs live boundary

- **Simulated:** everything under “Scenario runner”. Mock ports record
  calls; no `unlayer` global is touched (asserted in tests); the canvas
  JSON is byte-identical before and after (verified in browser QA).
- **Live:** the API explorer reads, Studio approvals, and their native
  `loadDesign` results. Live sections are headed “Live Unlayer results”.
- A simulated PASS never implies live acceptance; a failure in either
  world links to the same engine code, so a Lab fix is a Studio fix.

## Evidence format

`app/src/lab/evidence.ts`. One entry per notable event:

```json
{
  "id": "evt_...",
  "recordedAt": "2026-10-23T13:00:00.000Z",
  "operation": "scenario.stale-rejection | agent.describe | approve.applied | ...",
  "source": "simulated | live",
  "result": "pass | fail | error | info",
  "summary": "Human-readable one-liner.",
  "diffSummary": "1 change across 1 block",
  "policyVerdict": "pass | warn | fail | unknown | blocked | n/a",
  "native": { "ok": true, "loaded": true, "errorCount": 0 },
  "errors": [{ "message": "..." }]
}
```

Export (`Export evidence JSON`) downloads
`unlayer-lab-evidence.json`:

```json
{
  "exportedAt": "...",
  "generator": "unlayer-agent-lab",
  "warning": "Developer debugging evidence. Designs may contain sensitive content: ...",
  "entryCount": 3,
  "entries": [ ... ]
}
```

Rules: minimal metadata by default — no design payloads. An unchecked-
by-default checkbox adds the current canvas snapshot on export, with an
explicit sensitive-content warning. Key-shaped fields and token-shaped
values (`unlayer_sk_*`, `sk-*`, `Bearer …`) are scrubbed to
`[redacted]` / `[redacted-secret]` during serialization (tested).

## Integration snippets

`app/src/lab/snippets.ts` — copyable, dependency-free examples using
only documented native calls:

1. `describe` — connection check that counts `editors` (presence of
   `unlayer.agent` proves nothing).
2. `getDesign` — snapshot before proposing.
3. `approve` — re-read → compare → backup → `loadDesign` → check
   `ok`/`loaded` → surface joined error messages.

## Limitations

- Schema support depends on the builder version; older pinned builders
  get an explicit unsupported message (feature-detected at runtime).
- The Lab never writes: no apply, no exports, no preview-device control
  in M6 scope (see M7).
- Evidence lives in memory (capped at 100 entries); export explicitly to
  keep it.
- `hidden`-attribute switching keeps Lab state mounted but idle; no
  polling, no background traffic.

## How developers can reuse the engine

```ts
import { prepareParagraphEdit, approveEdit } from './engine/proposals';
import { diffDesigns, inspectBlocks } from './engine/designDiff';
import { evaluatePolicies, createPolicyGate, DEFAULT_POLICY_CONFIG } from './engine/policies';
import { describeAgent, getAgentDesign, loadAgentDesign, getAgentSchema } from './engine/unlayerAgent';
```

Pure modules import with zero side effects and no `react` dependency;
`AgentPort` lets tests (and your app) inject any transport. The Lab page
itself (`app/src/lab/LabPage.tsx`) is a working composition example:
props in (`proposal`, `lastApplied`, `rejection`, `evidence`), callbacks
out (`onRecordEvidence`, `onClearEvidence`).
