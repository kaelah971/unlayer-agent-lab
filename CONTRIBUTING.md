# Contributing to Unlayer Agent Lab

Thanks for your interest. This is a safety-focused lab, so reviews are
strict about fail-closed behavior: when in doubt, reject the change and
leave the canvas untouched.

## Setup (keyless first)

```bash
cd app
npm install
npm run dev        # http://127.0.0.1:5173/
```

Everything except real AI generation works with no credentials: manual
editing, policies, the Change Inspector, Developer Lab scenarios, and
autosave.

Optional AI backends (both loopback-only, both gitignored via
`app/.env` — copy `app/.env.example` first):

- Unlayer Cloud AI: set `UNLAYER_API_KEY` (paid; plan needs AI
  Assistant entitlement), then `npm --prefix app run server`.
- Groq BYOM: set `GROQ_API_KEY` (free tier works), optional
  `GROQ_MODEL`, then the same server command.

## Gates (run before every PR)

```bash
npm --prefix app run test:run   # 178 Vitest tests, Node mode, <2 s
npm --prefix app run build      # tsc -b + Vite (type-checks tests too)
npm --prefix app run lint
git diff --check
```

All four must pass. Never skip the build step — Vitest does not
type-check.

## Safety rules (non-negotiable)

- Nothing touches the canvas before explicit human approval.
- Proposals are validated against known block IDs and whitelisted
  operation types; unknown input fails closed, never repaired.
- Untrusted design values render as text — never injected HTML.
- Stale proposals (canvas changed mid-review) are rejected, not merged.
- New model providers must return constrained operations through the
  existing proposal pipeline — never raw design JSON applied directly.
- Do not weaken a policy gate or approval check to make a demo pass.

## Secret rules (non-negotiable)

- Keys live only in `app/.env` / server process env. Never commit
  `.env`, never print keys, never put them in `VITE_*` variables
  (those ship to the browser), never include them in tests except as
  obvious `SENTINEL-*` fakes, and never let them reach evidence
  exports or logs (presence-only logging).
- The local AI backend binds 127.0.0.1 with no auth or rate limiting
  **by design for local development**. Do not expose it, and do not
  submit PRs that would make it publicly reachable without adding
  authentication and per-user rate limits.

## What to work on

Good first areas: docs fixes, accessibility improvements, additional
deterministic Lab scenarios, new constrained operation types with
tests. Bigger changes (new providers, new block support) should start
as an issue describing the safety implications first.
