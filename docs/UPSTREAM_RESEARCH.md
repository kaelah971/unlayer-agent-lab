# Upstream Contribution Research (2026-10-23)

Read-only investigation of the official Unlayer repositories, motivated
by real friction met while building Unlayer Agent Lab (typed agent
adapter, autosave over `design:updated`, headless-browser QA against
the CDN embed). No code was pushed anywhere; findings below are
evidence-backed and propose small, testable contributions.

Sources (all public, MIT-licensed, actively maintained — both pushed
within days of this writing):

- `github.com/unlayer/react-email-editor` — ~5.2k stars, 803 forks,
  247 open issues, `master`. Thin React wrapper (`src/`: only
  `EmailEditor.tsx`, `types.ts`, `loadScript.ts`, `index.ts`) over the
  closed-source embed, typed via `@unlayer/types`.
- `github.com/unlayer/elements` — 426 stars, 17 forks, 16 open
  issues, `main`. React component library (email/web/PDF) with modern
  contributing setup (Node 20+, pnpm, CI + codecov).

## Opportunity 1 — `loadScript` never reports CDN failure (recommended first PR)

- **Problem:** `src/loadScript.ts` wires `embedScript.onload` only.
  If `https://editor.unlayer.com/embed.js` fails (offline, CSP block,
  outage), queued callbacks never run and nothing reports the failure.
  In our lab this exact state reads as a permanent “Waiting for
  editor…” with no error path to display — reproducible by blocking
  the embed URL in devtools and mounting `<EmailEditor/>`.
- **Relevant files:** `src/loadScript.ts`; consumers in
  `src/EmailEditor.tsx` (`loadScript(() => setHasLoadedEmbedScript(true))`).
- **Proposed fix:** `embedScript.onerror` (and the pre-existing-script
  branch) surfaces a failure — e.g. an error-first callback or a
  rejected promise — so hosts can render “editor failed to load” and
  retry. Precedent: issue #496 / fix #510 already hardened the
  preloaded-script path in this same file; error surfacing is the
  natural remainder.
- **Testing:** jsdom/RTL test dispatching `error` on the script element
  asserts the failure callback fires once; existing onload/preload
  tests keep passing.
- **Benefit:** every embed consumer gets a diagnosable offline/CSP
  failure instead of an infinite spinner.
- **Feasibility:** high — ~10 lines + tests, no API design risk.

## Opportunity 2 — forwarded event listeners are never removed

- **Problem:** the listener effect in `src/EmailEditor.tsx`
  (`useEffect(..., [editor, methodProps.join(',')])`) calls
  `editor.addEventListener` for every `on*` prop and `editor:ready`,
  with no cleanup. Under React StrictMode (double effect-invoke in
  dev) or when handler props change, registrations accumulate: our
  lab runs StrictMode and had to guard its own `design:updated`
  autosave subscription against double-scheduling (see M2 notes on
  double-mount listener leaks). Repro: StrictMode + counting
  `design:updated` handler shows 2× invocations in dev.
- **Relevant files:** `src/EmailEditor.tsx` (listener effect);
  `@unlayer/types` `editor.d.ts` already declares
  `removeEventListener(type)`.
- **Proposed fix:** track registered event types and call
  `editor.removeEventListener(type)` in the effect cleanup. Note for
  review: removal is by type, so it also drops consumer-added handlers
  for the same type obtained via `onReady` — document or scope
  accordingly.
- **Testing:** mock-editor test asserting add/remove pairing across
  mount → unmount and across handler-prop change.
- **Benefit:** no duplicate autosave/export/ready callbacks for any
  StrictMode or re-rendering host.
- **Feasibility:** medium-high — small diff, but the by-type removal
  semantic needs maintainer agreement.

## Opportunity 3 — agent-API feature-detection guidance

- **Problem:** `unlayer.agent.describe/schema` availability varies by
  builder version; calling them unconditionally throws “not supported”
  on older embeds. Our lab ships a typed adapter with explicit
  `unsupported`/missing-agent states (unit-tested), because the
  wrapper README documents no agent-API availability story.
- **Relevant files:** wrapper `README.md`; `src/types.ts`
  (`UnlayerEmbed.agent: AgentApi`); related docs effort in #535/#536.
- **Proposed contribution:** docs-first — a short “Working with the
  Agent API” section with a version-tolerant detection snippet
  (issue-first, since #535/#536 show maintainers actively writing
  adjacent docs; avoid duplicating their Elements-to-editor guide).
- **Testing:** docs-snippet compile check in the style of their
  `<!-- check-docs -->` convention.
- **Benefit:** fewer “agent is undefined / not supported” issues from
  integrators on older embeds.
- **Feasibility:** high for docs; code helpers only if maintainers
  want them.
