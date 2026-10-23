# Demo Plan — Unlayer Agent Lab (2–3 minutes)

Audience: a technical reviewer. No API key needed — everything below
runs keyless. Say out loud what is simulated vs live (the app labels it;
so should you).

## 0:00 — Land on AI Studio (20 s)

Show the Unlayer builder loaded and the status
“Connected to 1 agent-enabled editor(s).” Say: one page, two
workspaces, one editor instance — switching never remounts the canvas.

## 0:20 — Human-approved edit (60 s)

1. Type replacement text for the first paragraph → **Prepare Text
   Edit**. Point out: “Proposal ready. The canvas has not been
   changed.”
2. Open the Change Inspector: “1 change across 1 block”, Before/After,
   “Local structural preview” note, policy checks all passing.
3. Click **Approve Change** → “Approved change applied successfully.”
   Canvas text updates; “Last applied change” shows Unlayer's own
   ok/loaded/audit result.

## 1:20 — Stale protection (30 s)

Prepare another edit, then change the canvas directly (Developer Mode
→ edit, or a second prepare target). Approve → “The design changed
after this proposal was prepared.” The human's canvas edit wins; the
stale proposal is discarded, not forced through.

## 1:50 — Developer Lab (40 s)

Switch to **Developer Lab** (editor stays mounted). Click **Check
connection** → **Load schema** → **Read current design** (read-only;
nothing here writes). Run **Run all scenarios**: 5 pass, labeled
“Simulated — never touches the canvas.” Export evidence JSON.

## 2:30 — Close (20 s)

AI generation is intentionally off: “AI is not configured” with
Generate disabled — real AI needs a server-held Unlayer key and is
gated BLOCKED until a keyed run. Manual editing, policies, the Lab,
and autosave are the verified product today.

If anything fails live: the app surfaces plain-language status lines
(empty prompt, stale, blocked, rejected with native error paths) —
narrate the message, don't click past it.
