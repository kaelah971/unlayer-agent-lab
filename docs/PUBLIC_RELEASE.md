# Public Release Plan (no push yet)

## Recommended repository setup

- **Name:** `unlayer-agent-lab`
- **Description:** “Human-approved AI editing for the Unlayer email
  builder — proposals, policy guardrails, and a Groq BYOM provider,
  with a Developer Lab for safe integration testing.”
- **Visibility:** public, **without** pushing until the checklist
  below is done.
- **Topics:** `unlayer`, `email-builder`, `ai-agents`,
  `human-in-the-loop`, `groq`, `react`, `typescript`, `vite`,
  `email-design`, `byom`
- **License:** MIT (`LICENSE` at root; `package.json` stays
  `"private": true` so nobody can accidentally `npm publish`).

## Pre-push checklist

1. `git status` clean except intended files; `git log` reviewed.
2. 178 tests + `build` + `lint` + `git diff --check` green.
3. `app/.env` present locally but untracked and gitignored (verify:
   `git check-ignore -v app/.env`, `git ls-files | grep env` shows
   only `.env.example`).
4. Keyless run verified: fresh clone → `npm install` → `npm run dev`
   works with no credentials; AI sections show setup pointers.
5. Committer identity: history currently shows a personal Gmail on all
   commits. Set `git config user.email` to a non-public/noreply
   address **before** pushing so *future* commits are clean. The
   existing 16 commits keep the old address unless history is
   rewritten — do NOT rewrite without explicit approval; accept and
   disclose, or approve a rewrite first.
6. Create the GitHub repo **empty** (no README/license/template
   commits) to avoid a divergent history, then add the remote and
   push `main` once.
7. After pushing: confirm no secret-scanning alert, confirm the
   `.env.example`-only contract, enable Dependabot + secret scanning.

## Safe public demonstration (no keys exposed)

- **Default demo = keyless.** Manual editing, policies, inspector,
  Developer Lab scenarios, and autosave all run without credentials —
  this is the recorded 2–3 minute walkthrough (`docs/DEMO_PLAN.md`).
- **Groq live segment (optional, local only):** run the loopback
  backend on your own machine with your own key; screenshare the
  browser only. Never print the key, never open `app/.env`, the
  Network tab, or server logs on stream. The audience sees the
  proposal → approval → canvas update; the key never leaves your
  process (architecture guarantees same-origin, keyless browser).
- **Never:** expose the backend publicly, deploy the `/api` proxy to a
  host, or commit run logs (they carry prompt sizes at most, but keep
  the habit).

## Architecture summary (for the repo About / wiki)

```
Browser (React + Unlayer embed) ──same-origin /api──▶ loopback backend (node:http)
  AI Studio: proposals → ChangeInspector → policy gate → approval → agent.loadDesign
  Developer Lab: read-only explorer, mock scenarios, evidence export (in-memory)
Providers: Unlayer Cloud AI (full design; needs entitled key) ·
           Groq BYOM (strict-schema paragraph ops; free tier)
```

Trust model: keys live only in the backend process; the model (Groq)
returns validated operations, never design JSON; nothing reaches the
canvas before human approval; stale proposals are rejected.

## Technical demo outline (5 minutes, keyless-safe)

1. (30 s) Two workspaces, one editor — switch without remount.
2. (90 s) Manual edit: prepare → inspector diff + policies → approve
   → canvas updates; then stale-proposal rejection.
3. (90 s) Developer Lab: explorer reads, 5 simulated scenarios pass,
   evidence export (show the sanitized JSON shape).
4. (60 s) Groq segment **only if local**: edit-with-Groq → 2 changes
   across 2 blocks → approve → autosave → reload restore.
5. (30 s) Close on honesty slide: Unlayer Cloud AI needs plan
   entitlement; scenarios are simulated; backend is loopback-only.

## Recommended first upstream PR

`unlayer/react-email-editor`: **surface embed script load failure in
`loadScript`** (`src/loadScript.ts`). Blocking the CDN today hangs
consumers on “Waiting for editor…” forever; an `onerror` path lets
hosts render a failure state. ~10 lines + jsdom test, precedent in
#496/#510, no API risk. Full rationale in
`docs/UPSTREAM_RESEARCH.md` (alternates: listener cleanup with
`removeEventListener`, agent-API detection docs).

## Exact publication steps (when approved)

```bash
git log --oneline -5            # confirm 64d88c1..HEAD chain
npm --prefix app run test:run && npm --prefix app run build && npm --prefix app run lint
git status --short              # clean
# create EMPTY public repo on GitHub (no init commits)
git remote add origin <url>     # only with approval
git push -u origin main
```

Do not push, create a remote, rewrite history, or deploy without
explicit approval.
