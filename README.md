# Unlayer Agent Lab

Two connected workspaces for human-approved email design with the
[Unlayer](https://unlayer.com) visual builder:

- **AI Studio** — the Unlayer visual editor plus AI generation. Every AI
  or manual change becomes a proposal that a human reviews in the Change
  Inspector, passes policy checks, and explicitly approves. Nothing
  touches the canvas before approval, and stale proposals (canvas edited
  mid-review) are rejected instead of applied.
- **Developer Lab** — an Agent API explorer, design inspection,
  deterministic scenario runner, evidence export, and copyable
  integration snippets. Scenario replays are simulated (mock ports) and
  never touch the canvas; live results come only from real `loadDesign`
  calls.

## Quick start

Prerequisites: Node ≥ 22.18, npm, Google Chrome (for browser QA only),
and network access to Unlayer's CDN for the embedded builder.

```bash
cd app
npm install
npm run dev        # http://127.0.0.1:5173/
```

Optional AI backend (real generation needs a paid Unlayer key):

```bash
cp app/.env.example app/.env   # then set UNLAYER_API_KEY
npm --prefix app run server    # 127.0.0.1:5198 (loopback only)
npm --prefix app run dev       # Vite proxies /api -> the AI server
```

Checks:

```bash
npm --prefix app run test:run
npm --prefix app run build
npm --prefix app run lint
```

## Credentials

| Credential | Required? | Where it lives |
|---|---|---|
| None | No — manual editing, policies, Lab, autosave all work keyless | — |
| `UNLAYER_API_KEY` (`unlayer_sk_*` server key) | Only for real AI generation; consumed as AI credits | `app/.env` (gitignored) → server process env → `Authorization: Bearer` to api.unlayer.com |
| `UNLAYER_PROJECT_ID` | Only for Personal Access Tokens (`unlayer_pat_*`) | Same as above |

Without a key the UI says “AI is not configured” and disables
Generate; manual editing keeps working. Never put keys in `VITE_*`
variables — those ship to the browser. The production bundle contains
zero key references (verified by grep; see `docs/RELEASE_CHECKLIST.md`).

## Verified vs unverified

**Verified in a real browser (system Chrome headless + CDP, M7A):**
workspace switching preserves the editor (1 iframe, canonical design
unchanged); Agent API connection; saved-design restore across reload;
proposal prepare → approve with canvas update; stale-proposal rejection
keeping the external edit; discard; Change Inspector rendering;
default-allow policy display; explorer (connection, schema, block
inventory); 5/5 simulated scenarios with canonical canvas isolation;
evidence export bytes (parsed, schema-checked, no secrets, opt-in
snapshot sanitized); XSS payload stored escaped with no live DOM tag;
360 px viewport with no horizontal overflow; logical Tab order with
visible focus; zero console errors. Automated suite: 144 Vitest tests,
plus `tsc -b` and ESLint clean.

**NOT verified — do not claim it:** live Unlayer Cloud AI generation
end-to-end (no `UNLAYER_API_KEY` in any test environment; the gate is
BLOCKED until a keyed run observes a real 200 with `output.data`
flowing through diff → policy → approval). Screen-reader pass,
real-device 360 px hardware check, quota/rate-limit UX against the real
API, and multi-turn conversation behavior are also still manual.

## Integration and deployment limitations

- The AI backend (`app/server/ai-server.ts`) binds **127.0.0.1 only**
  with **no authentication or rate limiting** — it is a local dev
  proxy. Do not expose it publicly as-is; a public deployment needs
  auth, per-user rate limits, and a server-held key budget, because the
  endpoint spends paid AI credits per call.
- The frontend Vite proxy (`/api` → 127.0.0.1:5198) is dev-only. Any
  production hosting must terminate `/api` at a real backend with the
  same loopback-and-auth discipline.
- First-paragraph-only manual transform (documented workflow limit);
  blank templates need a seeded paragraph before manual prepare.
- Stale detection is `JSON.stringify` equality (key-order sensitive).
- Evidence log is in-memory (cap 100), cleared on reload.
- See `docs/RELEASE_CHECKLIST.md` (gates), `docs/DEMO_PLAN.md`
  (2–3 minute walkthrough), `docs/TESTING.md` (full QA record),
  `docs/AI_STUDIO.md`, and `docs/DEVELOPER_LAB.md`.
