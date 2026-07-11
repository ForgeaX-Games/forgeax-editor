---
name: forgeax-editor-solo
description: >-
  Solo self-evolution loop for AI-first tools — one agent dogfoods a running tool, logs friction to a
  rolling experiment report, designs+lands a fix, verifies by real execution, then codifies the finding
  back into the tool's docs/anti-patterns. The lightweight counterpart to forgeax-closed-loop (no
  subagents, no state machine). First instance targets the forgeax editor EditGateway, but the loop is
  tool-agnostic. Use when dogfooding a tool to find and fix its friction, self-evolving an AI-first
  capability, or turning "try it and see what's awkward" into a disciplined iterate loop.
---

> [!IMPORTANT]
> **Read `DESIGN.md`** for *why* this loop exists (solo vs closed-loop, the self-evolution axiom) before
> asking "why not just fix it directly". This SKILL.md is the *how* — the loop, its gates, the report
> discipline. Load `rich-markdown` before writing the report. When the target is the editor gateway,
> the driver scripts live in the sibling `forgeax-editor-gateway` skill — this skill orchestrates, it
> does **not** re-derive the boot dance.

## What this is

A single AI runs a tight **dogfood → friction → fix → verify → codify** loop against a running tool it
is the primary user of. Two feedback layers make it *self-evolution*, not just iteration:

```mermaid
flowchart LR
  U["Use the tool<br/>(dogfood a real goal)"] --> F["Log friction<br/>(rolling report)"]
  F --> D["Design a fix"]
  D --> I["Implement"]
  I --> V["Verify by<br/>real execution"]
  V --> C["Codify"]
  C -->|"L1: tool improved"| U
  C -->|"L2: method improved"| S["this skill's<br/>anti-patterns + memory"]
  S -.-> U
```

| Layer | Feedback | Example (editor-gateway instance) |
|:--|:--|:--|
| **L1 tool** | friction → fix the tool | `describeComponent`/`listComponents` added after "can't see a component's fields before spawn" friction |
| **L2 method** | new friction-pattern / verify-trick → back into skill + memory | headless-verify-via-playwright-core recipe saved to memory; new anti-pattern appended here |

L2 is the point: the skill improves *itself* by being used. A loop that only does L1 is plain iteration.

## When to run vs when to route to closed-loop

| Signal | Route |
|:--|:--|
| Exploratory "let me use it and see what's awkward"; fix is small + local; one agent holds all context | **this skill** |
| Feature spans many files / needs adversarial review / requires requirements→plan→verify rigor | `forgeax-closed-loop` |
| Direct one-line fix, no discovery needed | neither — just edit + run gates |

Escalate mid-loop: if a friction's fix turns out to span subsystems, stop and hand the finding to
`forgeax-closed-loop` as a requirement. Don't grow this loop into a multi-agent one.

## The loop

> Each step has a **gate** — do not advance until it holds. The report is written *during*, not after.

```mermaid
flowchart TD
  G["0 · Goal + env"] --> DF["1 · Dogfood"]
  DF --> LF["2 · Log friction"]
  LF -->|"more to try"| DF
  LF -->|"goal walked end-to-end"| PR["3 · Prioritize"]
  PR --> DS["4 · Design fix"]
  DS --> IM["5 · Implement"]
  IM --> VF["6 · Verify (real run)"]
  VF -->|"green"| CD["7 · Codify"]
  VF -->|"red"| IM
  CD --> Ask["8 · Human gate"]
```

### 0 · Goal + env

**First read the experiments dir** (`<target>/experiments/*/report.md`) — the dated notebook of every prior
run. Skim each report's goal + its still-open friction (findings logged but deferred, e.g. "left for a
later round"); the run's `snippets/` show exactly how it drove the tool. The new goal must **advance the
frontier**, not re-tread it:

- **Different** from every prior goal — a fresh capability or user story, not a paraphrase.
- **More meaningful** — climb the ladder (single-op probe → multi-step authoring → composed workflow →
  a real end-user task that chains several capabilities). Don't keep circling the simplest goals once
  they're proven; each run should exercise surface the notebook hasn't stressed yet.
- **Building on prior findings** — prefer a goal that reaches a *deferred* friction from an earlier run
  (the notebook literally hands you the next target) over one invented from nothing.

Then state it as a concrete end-to-end goal a real user would have (not "test the API" — *"an AI builds a
small scene arrangement"*). Confirm the tool is running and reachable; note ports/health in the report's
env line. Never assume — probe (`curl`, a health script) and record the result.

**Gate:** goal is a user story with an explicit success criterion ("each step doable by an AI that reads
docs only, not source"); env probe recorded; **the report's "Prior runs" line names the surveyed reports
and states how this goal advances beyond them** (new surface and/or a deferred friction it now reaches).

### 1 · Dogfood

Walk the goal as the tool's *intended user* would — reading only the tool's public docs, not its source.
Reading source to *drive* the tool defeats the experiment (you'd paper over doc gaps the real user hits).

**Gate:** you invoked the real surface (script/API/CLI), not a mock.

### 2 · Log friction (rolling)

Every stumble is a **friction point** logged *the moment you hit it* — not batched at the end. Each entry
classifies: is this a **doc/contract** gap, an **API ergonomics** gap, an **environment** gap, or a
**semantic trap**? and a severity. Also log *positives* (things that worked well) — they tell you what
not to break.

**Gate:** report has a rolling friction table with ≥ {step, class, severity, one-liner} per entry, and it
was updated between steps (check timestamps/order, not a final dump).

### 3 · Prioritize

Rank friction by severity × how badly it misleads a docs-only user. A **contract error** (docs disagree
with implementation) outranks a cosmetic gap — it silently breaks correctness.

**Gate:** top finding chosen with a stated reason.

### 4 · Design fix

For the top finding, investigate *why* it exists before proposing a fix. Prefer the **minimal, symmetric**
change that fits existing patterns (mirror a sibling API) over a new parallel mechanism. Run it against the
target repo's architecture razors (for forgeax: SSOT / Derive-don't-Duplicate / one-door). Widen the lens:
don't only fix the literal friction — ask what *class* it belongs to (one missing introspection leg, not
one missing method).

**Gate:** fix named, its SSOT identified, alternatives (incl. "don't fix, document instead") weighed in
the report.

### 5 · Implement

Land the change. Add a test that would have caught the friction. Match surrounding code density/anchors.

**Gate:** code + test written; test file runs.

### 6 · Verify by real execution

Not "tests pass" alone — **drive the fixed capability end-to-end through the real running tool** and observe
the behavior the friction was about. Prove the closed loop (e.g. discover→spawn succeeds on first try where
it used to fail). Run the repo's own gates (typecheck / unit / lint / surface-freeze). Restore any state you
mutated in the live tool.

**Gate:** live end-to-end evidence captured in the report **and** repo gates green — both, with output
quoted. Evidence before assertion (see `verification-before-completion`).

### 7 · Codify (the self-evolution step)

Two writes, both required:

1. **L1** — update the tool's own docs (the doc gap that caused the friction is now closed).
2. **L2** — if the loop surfaced a reusable *method* fact (a verify recipe, an environment gotcha, a new
   friction-pattern), write it: a durable one to **memory**, a loop-method one to **this skill's
   anti-pattern list** below.

**Gate:** L1 doc updated; L2 fact written or an explicit "nothing reusable this round" noted.

### 8 · Human gate

Present the finished loop for verdict. AI completes all internal iterations first; the human sees mature
output and holds veto (architecture-principles §8). Do not re-enter the loop after approval without a new
goal.

**Gate:** human approves, or names the next friction to chase.

## The run directory

Each loop run is **one self-contained directory**, not a lone file, under the target's experiments dir
(editor instance: `skills/forgeax-editor-gateway/experiments/`). Name it `<YYYY-MM-DD>-<goal-slug>/`
(e.g. `2026-07-12-hierarchy-authoring/`) — **date + goal name, one dir per run; never overwrite a prior
run's dir**, so the experiments dir accumulates a dated lab notebook of reproducible runs. The whole
`experiments/` tree is a run artifact (gitignored) — don't stage it in the fix's PR.

Everything a run touched lives in its dir — so a later reader (or the next round surveying the frontier)
can re-run it, not just read about it:

| Path in the run dir | Holds |
|:--|:--|
| `report.md` | the rolling report (sections below), written *during* the loop |
| `snippets/*.mjs` (or `.js`) | every eval snippet you drove the tool with — the exact code, not a paraphrase in prose |
| `out/*.json` / `*.log` | captured outputs the report's evidence quotes (redirect here, not to `/tmp` where it's lost) |

> [!TIP]
> Drive the tool by writing a snippet **into `snippets/` first**, then `gateway-eval.mjs --file <that>` →
> redirect to `out/`. Don't paste inline throwaway code: a run whose driving code lives only in shell
> history isn't reproducible, and the next round can't build on it.

`report.md` sections:

| Section | Holds |
|:--|:--|
| Prior runs | which run dirs were surveyed + how this goal advances the frontier (new surface / a deferred friction it now reaches) — the anti-circling record |
| Goal + success criterion | the user story, the "docs-only AI can do each step" bar |
| Env line | ports / health / driver, probed not assumed |
| Friction table (rolling) | `# · step · class · severity · one-liner`, updated between steps |
| Positives | what worked — the don't-break list |
| Design | top finding → investigation → fix → alternatives → acceptance criteria |
| Results | live end-to-end evidence + gate output, quoted (pointing at `snippets/` + `out/`) |

> [!TIP]
> The single most useful discipline: **log friction the instant you feel it.** By the end you've
> rationalized around every rough edge and forgotten it was rough. The report is an instrument, not a
> write-up.

## Anti-patterns (L2 — grown by the loop itself)

> Each entry was learned by running this loop. Append new ones in step 7.

- **Reading the tool's source to drive it.** You then can't see the doc gaps the real user hits — the
  whole experiment measures docs-vs-reality. Drive from public docs only; reading source is for the *fix*,
  not the *dogfood*.
- **Batching friction into a final write-up.** Rationalization erodes the rough edges; the rolling log is
  the primary artifact, the summary is derived.
- **"Tests pass" as the finish line.** Unit-green with a broken end-to-end is the classic false done. Drive
  the real tool and observe the friction's behavior gone.
- **Fixing the literal friction, missing the class.** "Add one method" when the real gap is "a whole
  introspection leg is missing" — widen before you cut.
- **Adding a parallel mechanism instead of mirroring a sibling.** A second copy (a `listMethods()` beside
  `listOps()`, a static schema beside a dynamic registry) violates SSOT. Prefer the change that makes the
  new surface *symmetric* with what exists, or that a runtime query already covers (Derive, don't
  Duplicate).
- **Contract errors ranked below cosmetics.** When docs disagree with the implementation (a missing param
  in a documented signature), that silently breaks a docs-following user — it outranks any "nice to have".
- **A whole method family missing from the reference is a contract error, not an omission.** When an
  API doc table lists most of a surface but silently drops a related family (undo/redo/canUndo beside
  dispatch/commit), a docs-only user assumes the missing calls follow the table's dominant convention.
  If they don't — e.g. `undo()` returns a bare `boolean` while every tabled method returns `{ok,…}` —
  the user writes `undo().ok` and it silently no-ops. The fix is doc-only (mirror the real signature +
  flag the shape difference); prove it by adding the family's name as a required anchor in the skill's
  own validator, so the gap can't recur. Ranks with contract errors, above cosmetics.
- **Deferring a fix to "docs will cover it" and never writing the docs.** A prior loop can *decline* a
  code fix for the right reason (SSOT) and hand the burden to documentation — then never write it, leaving
  the gap fully open. When you defer to docs, the doc write IS the fix; it is not optional follow-up.
- **Unbounded loops inside an eval snippet.** `while(gateway.canRedo()) gateway.redo()` freezes the host
  page forever if the predicate misbehaves (eval has no timeout — SKILL.md "Dead loop no interrupt").
  Bound every eval loop (`&& steps<50`) even when you "know" it terminates.
- **Circling the easy goals — not surveying the notebook first.** Each run re-picks a goal near the
  simplest proven one ("spawn + reparent again"), so the notebook fills with near-duplicates and the tool's
  harder surface never gets stressed. Step 0 must *read the experiments dir first* and pick a goal that is
  different from every prior run and climbs the ambition ladder — ideally one that reaches a friction an
  earlier run explicitly deferred. The dated notebook exists to be built *on*, not beside.
- **Throwaway driving code — a run that can't be re-run.** Pasting eval snippets inline and redirecting to
  `/tmp` leaves the report's evidence unbacked: the code that produced it is gone, so the next round can't
  reproduce or extend it. The run's driving snippets + captured output are part of the artifact — write
  snippets into the run's `snippets/`, outputs into `out/`, and have the report point at them.
- **Skipping the L2 write.** If the loop taught you a verify recipe or an env gotcha and you don't record
  it, the next loop re-derives it. The codify step is not optional.
- **Growing this loop into a multi-agent one.** When a fix spans subsystems, escalate to
  `forgeax-closed-loop` — don't bolt reviewers/state onto the solo loop.

## Driving the editor instance

The target's driver scripts are owned by `forgeax-editor-gateway` — reuse, don't re-implement.

| Need | Use |
|:--|:--|
| Editor already open + stable (warm) | `node skills/forgeax-editor-gateway/scripts/gateway-live.mjs --file <snippet>` (needs the bridge; `--health` first) |
| No editor, OR a freshly cold-booted stack | `node skills/forgeax-editor-gateway/scripts/gateway-eval.mjs --file <snippet>` (boots its own headless browser at :15290) |
| Full playwright absent | point `FORGEAX_PLAYWRIGHT` at a `playwright-core` index + `FORGEAX_CHROMIUM` at a cached chromium binary (memory: `gateway-headless-verify-playwright-core`) |
| Repo gates | `bun -F @forgeax/editor-core test` · `bun -F @forgeax/editor-core typecheck` (needs engine `.d.ts` — `tsc -b` first) · `bun run lint` · `bun run lint:dep` |

> [!CAUTION]
> **A cold-booted stack's live bridge flaps — don't dogfood through it.** Right after
> `bun fx start`, vite re-optimizes deps and reloads the page repeatedly, so `gateway-live.mjs
> --health` reports `pageConnected:true` (WS transport) while `eval` still 30s-times-out (the page
> is mid-reload, not eval-ready). `--health` proves transport, not readiness. On a cold boot use
> **headless `gateway-eval.mjs`** (it boots its own clean browser); reserve `gateway-live.mjs` for a
> warm window you're actively watching. (round-3 friction #2)

For any *other* tool instance, substitute its own driver + gates — the loop and report discipline are
unchanged.
