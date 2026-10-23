# BYOM — Groq Provider (M8)

Bring Your Own Model: AI Studio can use GroqCloud instead of Unlayer
Cloud AI. The safety architecture does not change — the Groq path
produces **constrained paragraph-edit operations** that travel the
exact same ChangeInspector → policy gate → stale check → human
approval → `agent.loadDesign` pipeline as every other proposal.

## Why operations, not designs

Unlayer Cloud AI returns full design JSON. A third-party LLM must not
be trusted with that power: a hallucinated block ID or invented
structure could corrupt the canvas. So Groq returns only:

```json
{ "operations": [{ "op": "set_paragraph_text", "blockId": "seed-p1", "text": "New copy" }] }
```

- One operation type in v1: `set_paragraph_text` on existing,
  unlocked paragraph blocks. No HTML (payloads are plain text,
  HTML-escaped on apply), no structural changes, no new blocks.
- Unknown block IDs, unsupported op types, empty/oversized text, and
  over-count batches are **dropped**, never repaired. Zero surviving
  operations → the request fails closed (`invalid_response`), never an
  empty proposal.

## Model selection

Default: **`openai/gpt-oss-20b`**, override with `GROQ_MODEL`.

Chosen 2026-10-23 from Groq's official docs
(`console.groq.com/docs/structured-outputs`) intersected with the live
`GET /models` list for this key:

- The docs list strict-mode (`strict: true`, constrained decoding,
  guaranteed schema compliance) support for `openai/gpt-oss-20b`,
  `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, and
  `meta-models/muse-spark-open`. Of these, this key can call the
  first three.
- `gpt-oss-20b` is the smallest/fastest of the strict-capable models
  and ample for a ≤10-operation paragraph-edit task. Strict mode makes
  the JSON schema enforceable server-side instead of hoped-for.

If you override `GROQ_MODEL`, pick a model with strict structured
outputs; otherwise the backend still validates, but schema compliance
is best-effort instead of guaranteed.

## Request flow

```
Browser ──POST /api/ai/groq-generate──▶ backend ──POST chat/completions──▶ Groq
{instruction, mode:'edit', baseDesign}   │ validate → inventory → strict json_schema   {operations}
                                         │ 401/403/429/400/5xx/timeout mapping
                                         ▼
                                   {operations, dropped, model}
```

1. Backend validates input with the shared limits (4000-char prompts,
   4 MB designs), rejects non-`edit` modes, and requires `GROQ_API_KEY`
   (else `501 groq_not_configured`).
2. Backend derives the paragraph inventory from `baseDesign`
   (unlocked paragraphs with readable/rewritable Lexical text, max 20
   blocks × 300 chars) and embeds it in the system prompt alongside
   `response_format: { type: 'json_schema', json_schema: { strict: true,
   … } }` (`temperature: 0`, `max_completion_tokens: 2000`).
3. Backend coarsely validates the reply (shape + ID membership) and
   returns `{ operations, dropped, model }`.
4. Frontend `finalizeGroqGeneration` re-checks the live canvas for
   mid-generation edits, re-validates every operation against a fresh
   inventory, applies survivors to a clone (escaped HTML + Lexical
   consistency, same rules as manual edits), requires a **complete**
   diff with ≥1 change, evaluates policies, and only then yields a
   proposal. Approval reuses `approveEdit` verbatim.

## Setup

1. Free key at https://console.groq.com → set `GROQ_API_KEY` in
   `app/.env` (gitignored; optional `GROQ_MODEL` override).
2. Terminal 1: `npm --prefix app run server` (loopback only).
3. Terminal 2: `npm --prefix app run dev`.
4. In AI Studio pick **Groq (BYOM)**, write an instruction, click
   **Edit with Groq**. Without a key the button disables with a
   pointer to this document; manual editing keeps working.

## Secret handling

- `GROQ_API_KEY` lives only in `app/.env` / process env on the
  developer machine. The browser sends same-origin JSON with no
  `Authorization` header (unit-tested); the bundle contains no
  `GROQ_API_KEY` / `gsk-` references; server logs carry presence
  (`groqConfigured`) and sizes only; `/api/ai/groq-status` leaks only
  `{ configured, model }` (the model name is not a secret).
- Evidence exports never include operations payloads beyond the
  diff summary the UI already displays.

## Limits (v1)

- Edit-only: no create mode, no image/menu/button blocks, no locked
  blocks, max 10 ops × 2000 chars per turn.
- No conversation memory: one instruction per turn.
- The Groq backend endpoint is loopback-only with no auth or rate
  limiting — same local-dev discipline as the Unlayer proxy. Do not
  expose it publicly (paid/free-tier abuse vector).
- Free-tier rate limits apply (`rate_limited` surfaces with
  `retryAfterMs` when Groq sends `Retry-After`); no automatic retries.
