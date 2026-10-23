# AI Studio (M5)

Prompt-driven AI design generation and editing for Unlayer Agent Lab,
built on Unlayer's official server-side generation API and reviewed
through the existing safe approval flow. No separate AI pipeline was
invented: the AI path produces proposals that travel the exact same
ChangeInspector → policy gate → stale check → human approval →
`agent.loadDesign` pipeline as manual edits.

## Architecture

```
Browser (React)                          Local backend (node, 127.0.0.1:5198)
─────────────────                        ──────────────────────────────────────
AI section (App.tsx)                     POST /api/ai/generate
  │ instruction + mode                     │ validate → Bearer unlayer_sk_*
  ▼                                        ▼
aiProvider.requestAiGeneration ──fetch──▶ AI server ──fetch──▶ api.unlayer.com
  │ (same-origin /api, no keys)                 │  /v3/templates/generate
  ▼                                             ▼
aiProposals.finalizeAiGeneration     200 {output.data} / 304 / {error,message}
  │ (stale check, diff, policies)
  ▼
PreparedParagraphEdit (source: {kind:'ai'})
  │ ChangeInspector → policy gate → approveEdit → agent.loadDesign
  ▼
NativeResultPanel (Unlayer validation/audit)
```

Modules:

- `app/src/ai/aiProvider.ts` — same-origin fetch client with timeout
  (120 s default) and AbortController cancellation. Never holds secrets;
  validated by a test asserting no `Authorization` header and no
  key-like fields in the request.
- `app/src/ai/aiProposals.ts` — `prepareAiProposal` (validates the AI
  design, fails closed on incomplete diffs, runs policies) and
  `finalizeAiGeneration` (maps provider outcomes, re-checks the live
  canvas for mid-generation edits, converts failures to messages).
- `app/server/ai-server.ts` — zero-dependency local backend (plain
  `node:http`, run with `node` type stripping; requires Node ≥ 22.18).
- `app/src/engine/proposals.ts` — unchanged approval engine; AI
  proposals carry `source: { kind: 'ai', mode, instruction }` and reuse
  `approveEdit` verbatim.

## Setup

1. Copy `app/.env.example` to `app/.env` and set `UNLAYER_API_KEY`
   (a `unlayer_sk_*` server key from the Unlayer console).
2. Terminal 1: `npm --prefix app run server` (listens on 127.0.0.1:5198).
3. Terminal 2: `npm --prefix app run dev` (Vite proxies `/api` → the AI server).
4. Open the app, pick **Edit current** or **Create new**, write an
   instruction, click **Generate with AI**.

Without a key, the UI shows “AI is not configured…” and manual editing
keeps working. Never commit `.env` (gitignored); never put the key in
Vite `VITE_*` variables — those ship to the browser.

## Local backend

- `GET /api/ai/status` → `{ configured: boolean }` (presence only).
- `POST /api/ai/generate` `{ instruction, mode, baseDesign }` validates
  (prompt 1–4000 chars, design ≤ 4 MB serializable JSON, body ≤ 6.5 MB),
  calls Unlayer with `Bearer` auth (+ `X-Project-Id` only when
  configured for PAT keys), and maps responses 1:1 (see below).
- Timeouts: 120 s upstream abort; no automatic retries. All failures
  return structured `{ error, message, retryable }` (+ `retryAfterMs`
  when Unlayer sends `Retry-After`).
- Logs carry method/path/status/sizes only — never the key, prompts, or
  designs. Presence of a key is logged redacted (`present(lenN)`).
- `.env` is read from the server working directory (and its parent);
  real environment variables take precedence.

## Secret handling

- Keys live only in `process.env` / `app/.env` on the developer machine.
- `app/.env.example` contains placeholders, no secrets, and is committed.
- `app/.gitignore` excludes `.env`.
- The frontend bundle contains no `UNLAYER_API_KEY` reference and sends
  no `Authorization` header (covered by an automated test).
- The `/api/ai/status` endpoint leaks only a boolean.

## AI provider contract

Request (same-origin): `{ instruction: string, mode: 'create' | 'edit', baseDesign: <design JSON> }`.

Upstream (server → Unlayer), per
`https://docs.unlayer.com/server/cloud-api/reference` (`POST
/v3/templates/generate`, verified against the published
`cloud-api-v3.yaml` OpenAPI spec):

```json
{
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "<instruction>" }] }],
  "output": { "kind": "template", "displayMode": "email" },
  "context": { "fullDesign": { "...current design..." } }
}
```

`context.fullDesign` is sent only in `edit` mode. `output.data` in the
200 response is the full email design JSON for `kind: template`.

Server → frontend mapping:

| Upstream | Frontend result |
|---|---|
| 200 with `output.data` (object with `body`) | `{ status: 'ready', design, model?, creditsUsed? }` |
| 200 without usable data | `{ status: 'error', code: 'invalid_response' }` |
| 304 | `{ status: 'no-change' }` |
| 401 / 403 / 429 / 400 | `{ status: 'error', code: unauthorized/forbidden/rate_limited/invalid_request }` |
| timeout / network / 5xx / 504 | `{ status: 'error', code: timeout/unreachable/upstream_*, retryable: true }` |

No key configured → `501 ai_not_configured` → UI “not configured” state.

## Generation and editing flows

- **Edit current:** snapshot the live design → POST with `context.fullDesign`
  → AI returns a modified full design → stale re-check against a fresh
  `getDesign` → diff + policies → inspector → approval → native load.
- **Create new:** same, without `context`; the candidate is a brand-new
  full design. The inspector diff shows the full add/remove set honestly.
- **Mid-generation canvas edits:** the snapshot is compared after the
  response; any drift discards the AI design with “The design changed
  while AI was generating.”
- **Cancel:** AbortController cancels the in-flight request; nothing is
  applied.

## Approval sequence

Identical to manual edits: policy recheck (gate) → backup → `loadDesign`
→ native `ok/loaded/errors/protectedElements/audit` display. AI adds
two earlier gates: incomplete-diff rejection at prepare time, and the
generation-time staleness check. Policy FAIL/UNKNOWN blocks submission
before any backup or native call, exactly as in M4.

## Expected API access / credit requirements

- An Unlayer project with an `unlayer_sk_*` API key.
- AI generations consume AI credits per turn (see `GET
  /v3/projects/:id/ai-credits` and the `usage.aiCreditsUsed` field echoed
  in successful responses when provided).
- Image generation/editing is NOT enabled (`features.ai.image` unset);
  the app never requests it.

## Limitations and remaining deployment security work

- The AI server binds loopback only and has **no authentication or rate
  limiting**: local development only. Public deployment requires adding
  both (plus HTTPS, CORS allow-listing, per-user quotas) — explicitly
  out of scope and documented here so it is not forgotten.
- Request caps: 4000-char prompts, 4 MB designs, 6.5 MB bodies, 120 s
  timeout, no retries (deliberate: no surprise spend).
- The narrow manual paragraph transform is unchanged; AI proposals use
  the general whole-design path.
- `schemaVersion` upgrades from generated designs are passed through
  opaquely; the inspector diff reports structural changes only.
- No conversation memory: each turn sends a single user message.
- Live Unlayer generation was NOT exercised in automated tests or QA
  (no credentials in this environment) — see `docs/TESTING.md` M5.
