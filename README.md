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

AI providers (selectable in AI Studio): **Unlayer Cloud AI**
(full-design generation) and **Groq BYOM** (free-tier friendly;
constrained paragraph-edit operations only — it rewrites existing
paragraph text, it does not generate complete emails).

## Quick start

Prerequisites: Node ≥ 22.18, npm, Google Chrome (for browser QA only),
and network access to Unlayer's CDN for the embedded builder.

```bash
cd app
npm install
npm run dev        # http://127.0.0.1:5173/
```

Optional AI backends (pick either or both; both loopback-only):

```bash
cp app/.env.example app/.env   # then set UNLAYER_API_KEY and/or GROQ_API_KEY
npm --prefix app run server    # 127.0.0.1:5198 (loopback only)
npm --prefix app run dev       # Vite proxies /api -> the AI server
```

- Unlayer Cloud AI needs a paid key **with AI Assistant entitlement**
  (without it, requests fail with a plan-permission error).
- Groq BYOM needs a free-tier `GROQ_API_KEY`
  (https://console.groq.com); optional `GROQ_MODEL` override.
  See `docs/BYOM_GROQ.md`.

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
| `UNLAYER_API_KEY` (`unlayer_sk_*` server key) | Only for Unlayer Cloud AI; consumed as AI credits, and the plan needs AI Assistant entitlement | `app/.env` (gitignored) → server process env → `Authorization: Bearer` to api.unlayer.com |
| `GROQ_API_KEY` (`gsk_*`) | Only for Groq BYOM paragraph editing; free tier works | `app/.env` (gitignored) → server process env → `Authorization: Bearer` to api.groq.com |
| `GROQ_MODEL` | Optional model override (default `openai/gpt-oss-20b`; must support strict structured outputs) | `app/.env` → server only; the browser only learns the model name via status |
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
visible focus; zero console errors.

**Verified live (M7B/M8, one call each, no mocks):** Groq BYOM with
`openai/gpt-oss-20b` proposed “2 changes across 2 blocks” (4/4
policies pass), approved, applied to the canvas, autosaved, and
restored after reload. Unlayer Cloud AI with a valid key returned 403
`ai_forbidden` — the key works but the project plan lacks AI Assistant
entitlement, so full-design generation remains unverified by design,
not by integration failure. Automated suite: 178 Vitest tests, plus
`tsc -b` and ESLint clean.

**NOT verified — do not claim it:** Unlayer Cloud AI end-to-end (needs
an entitled key for a real 200 with `output.data`); non-default
`GROQ_MODEL` values live; real free-tier 429 handling; screen-reader
pass; real-device 360 px hardware check; multi-turn conversation
behavior.

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
- Groq v1 edits **existing paragraphs only** (≤10 ops/turn); it does
  not generate complete emails, touch other block types, or remember
  conversation context. See `docs/BYOM_GROQ.md`.
- Stale detection is `JSON.stringify` equality (key-order sensitive).
- Evidence log is in-memory (cap 100), cleared on reload.
- See `docs/RELEASE_CHECKLIST.md` (gates), `docs/DEMO_PLAN.md`
  (2–3 minute walkthrough), `docs/TESTING.md` (full QA record),
  `docs/AI_STUDIO.md`, and `docs/DEVELOPER_LAB.md`.
