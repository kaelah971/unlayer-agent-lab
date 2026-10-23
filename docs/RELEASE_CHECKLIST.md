# Release Checklist — Unlayer Agent Lab (M7A)

Date: 2026-10-23. Each gate is PASS, FAIL, or BLOCKED with the evidence
behind it. Do not ship while any gate reads FAIL; BLOCKED gates must be
waived explicitly or resolved.

## Automated gates

| Gate | Result | Evidence |
|---|---|---|
| `npm --prefix app run test:run` | PASS | 14 files / 144 tests pass |
| `npm --prefix app run build` (`tsc -b` + Vite) | PASS | Clean; bundle ~275 KB JS / 85 KB gzip |
| `npm --prefix app run lint` | PASS | Clean |
| `git diff --check` | PASS | No whitespace errors |

## Browser QA gates (system Chrome headless + CDP, no new deps)

| Gate | Result | Evidence |
|---|---|---|
| AI Studio loads; agent connects | PASS | “Connected to 1 agent-enabled editor(s).” |
| Workspace switching preserves editor | PASS | 1 iframe across switches; canonical design unchanged |
| Agent API explorer (connection / schema / read) | PASS | Editor list, schema block, block inventory incl. seeded `seed-p` |
| Saved designs restore across reload | PASS | “Saved design restored. Autosave ready.” + marker on canvas |
| Proposal prepare → approve | PASS | “1 change across 1 block”, canvas untouched until approval, then updated |
| Stale proposals protect human edits | PASS | External edit kept; “changed after this proposal” message |
| Discard | PASS | “Proposal discarded.”, canvas unchanged |
| Change Inspector + native result panel | PASS | Diff line, ok/loaded/audit display |
| Default policy display (all pass, approval allowed) | PASS | PolicyList renders; engine block/warn paths covered by unit tests |
| Simulated scenarios isolated from canvas | PASS | 5/5 pass; canonical design JSON identical before/after (3068 = 3068 B) |
| Evidence export valid + downloadable | PASS | 2051 B captured, JSON parsed, entryCount 5 = entries 5, no `designs` by default, warning + generator present, zero key-like leaks; opt-in snapshot (6174 B, `currentDesign`) sanitized, no leaks |
| No unsafe HTML rendering | PASS | Payload stored as `&lt;img` (no live tag in HTML field); 0 live `img` in Studio DOM; raw text only inside Lexical JSON, rendered as text |
| Desktop usability (1280×900) | PASS | All flows above at desktop viewport, zero console errors |
| 360 px viewport | PASS (emulated) | innerWidth 360, docScroll 360, no horizontal overflow. Real-device hardware check still manual |
| Keyboard + focus | PASS | Logical Tab order, 10 tabbable targets, 0 positive tabindex, solid 2 px `:focus-visible` outline on every stop, 0 unlabeled buttons, 4 live regions |
| Error states | PASS | Empty prompt, unconfigured AI (note + disabled Generate), invalid saved design / restore-failure paths (code + unit-tested messaging) |
| AI not-configured honesty | PASS | “AI is not configured…” note; manual editing unaffected |

## Security gates

| Gate | Result | Evidence |
|---|---|---|
| Secrets stay server-side | PASS | Only `app/server/ai-server.ts` reads `UNLAYER_API_KEY`; browser sends same-origin fetch with no `Authorization` header (unit-tested); bundle grep for `unlayer_sk_` / `UNLAYER_API_KEY` → 0 matches |
| Evidence redaction | PASS | `sanitizeForExport` redacts key-like values + secret-named fields (unit-tested); captured exports leak-free |
| Local AI proxy restrictions | PASS (as dev tool) | Binds 127.0.0.1; `.env` gitignored; logs redact key presence. **Not hardened for public use — see below** |
| localStorage hygiene | PASS | Keys `unlayer-agent-lab:design:v1`, `…:pre-approved-edit:v1`; designs only, no credentials; scenarios never write storage |

## Docs gates

| Gate | Result |
|---|---|
| `README.md` (run, credentials, verified-vs-unverified, limits) | PASS |
| `docs/DEMO_PLAN.md` (genuine 2–3 min walkthrough) | PASS |
| `docs/TESTING.md` (M7A record, no fabricated results) | PASS |
| `docs/M7A_PROGRESS.md` (recovery log) | PASS |

## BLOCKED / manual gates (do not claim as verified)

- **Live Unlayer Cloud AI generation: BLOCKED (attempted 2026-10-23,
  upstream refused).** Key detected and accepted (no 401); exactly one
  authorized CREATE request returned upstream **403** in ~4 s, mapped
  1:1 to `ai_forbidden` and surfaced as “You do not have permission
  to … The AI Assistant feature is not available on this project
  plan.” No proposal was created, the canvas was untouched, zero
  console errors. The project needs the AI Assistant feature enabled
  (or a plan that includes it) before a real 200 with `output.data`
  → diff → policy → human approval → `loadDesign` can be verified.
  See `docs/TESTING.md` M7B and `docs/AI_STUDIO.md` (live note). No
  second chargeable call was made.
- Headless file download to disk: not capturable in this environment
  (Chrome reports export success but writes no file; zero
  `downloadWillBegin` events even for a synthetic blob). The exact
  export bytes were verified in-page instead. **Manual spot-check:**
  click “Export evidence JSON” in a real browser and open the file.
- Screen-reader pass, real-device 360 px hardware check, quota/429 UX
  against the real API: manual.

## Deployment rules

1. Never expose the local AI server publicly: no auth, no rate limits,
   loopback-only by design. Public use needs authentication, per-user
   rate limiting, and key-budget controls — the endpoint spends paid
   AI credits per call.
2. Never commit `.env` or put keys in `VITE_*` variables.
3. Serve the built `app/dist` behind a backend that terminates `/api`
   with the same loopback-and-auth discipline as the dev proxy.
4. Re-run this checklist after any engine, Lab, or server change.
