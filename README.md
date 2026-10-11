# savepoint

```
     )
    ( (
   ) ) (
  ( ( ) )
  _/\_/\_
```

**Rest at the bonfire.** A Claude Code plugin that resets a long session's context back to a
checkpoint you wrote, but only at a clean step boundary, never in the middle of work.

> Experimental (0.1.0). Built for my own workflow and shared as is. Issues are welcome, with no
> promises about fixes.

## Why

Long sessions get slower, pricier and sloppier as the context grows. `/compact` helps, but it
spends a model call writing a lossy summary of everything. `/clear` throws everything away.

Savepoint takes a third route. Claude keeps a short **progress file** (what we're doing, key
paths, what changed, the exact next step). When a step is finished, you rest: the whole
conversation is archived to disk and replaced by that file. You pick up where you left off at a
fraction of the context, and no summary model call is made.

## What it looks like

- **Status line:** `bonfire 84k · ✓ saved`
- **A band above the prompt** once the context passes 60k and a step is done. The fire grows
  with the context (steady, tall, roaring) and offers **Rest at bonfire**, **Kindle a save** or
  **Later**.
- **`/savepoint`** shows the fire, the context size and whether a reset is allowed right now.
- **`/savepoint reset`** rests. After a reset you'll see `◇ BONFIRE LIT ◇` and the path of the
  archived conversation.

## Install

```
/plugin marketplace add KYWAxx/savepoint
/plugin install savepoint@savepoint
```

## How it works

### The progress file

One file per working directory:
`~/.claude/progress/<cwd with non-alphanumerics replaced by ->.md`.
For example, `/home/me/proj` uses `~/.claude/progress/-home-me-proj.md`.

Once the context passes 60k tokens, savepoint adds a short note to each of your prompts telling
Claude how big the context is and when to update this file. Below that, it stays out of the way.
You can always ask Claude to checkpoint yourself ("checkpoint the progress file").

### The step mark

When Claude finishes a step (the result landed and checked out, nothing half-done) and has
saved, it ends its reply with:

```
✓ step done · saved · good time to reset (ctx 84k) · type /savepoint reset
```

That line is what unlocks the **Rest** button. The mark stays valid until work happens
(an Edit, Write, NotebookEdit, Bash or Agent call finishes), so a plain follow-up question
does not clear it. The older form without the trailing hint is still recognized.

### On claude.ai/code (Remote Control)

The band and status line do not draw there, so there is no Rest button. Guard notes,
`/savepoint` and `/savepoint reset` work when typed: after the step line, type
`/savepoint reset`.

### Safeguards

A reset happens only when **all** of these hold:

1. You asked for it (button or `/savepoint reset`). Auto-compact and normal `/compact` are untouched.
2. The progress file exists, has real content and was saved in the last 15 minutes.
3. No `Edit`, `Write`, `NotebookEdit`, `Bash` or `Agent` call finished after that save.
   Writing the progress file itself doesn't count as work.
4. Nothing is still running: no turn, no tool call, no subagent.
5. Claude's last reply carried the step mark. `/savepoint reset force` skips **this check only**.
6. The full conversation is archived to `~/.claude/progress/<slug>.archive/<timestamp>.md`
   before it is replaced. Nothing is deleted.

If a check fails, savepoint tells you why and what to do, for example
`Not reset: checkpoint is 22m old. To fix: ask Claude to checkpoint again.`
If anything goes wrong during the reset itself, it fails closed and leaves the conversation as it was.

### After `/clear`

The first prompt after `/clear` gets the progress file's tail attached, so a manual clear
resumes too. You can turn this off.

## Settings

Set these via `/plugin` (configure savepoint).

| Option | Default | What it does |
|---|---|---|
| `progressDir` | `~/.claude/progress` | Where progress files and archives live |
| `switchK` | 60 | Context size (k tokens) where the guard notes start |
| `wrapK` | 110 | Where Claude steers toward finishing the current step |
| `hardK` | 150 | Where Claude checkpoints every turn |
| `freshMin` | 15 | How old a save can be (minutes) and still allow a reset |
| `restoreChars` | 6000 | How much of the progress file's tail a reset or `/clear` reloads |
| `guard` | true | Add guard notes to prompts |
| `restoreOnClear` | true | Reload the progress file after `/clear` |
| `userName` | `the user` | How guard notes refer to you |

## Notes for plugin authors

Things I hit building this, in case they save you time:

- A compaction a plugin raises itself (`$.session.compact`) **skips that plugin's own
  `session.compact` hooks**. Savepoint instead runs the real `/compact savepoint reset` through
  `$.command.run`, and its own hook answers that.
- Compactions and prompts are refused from inside a held turn (a command handler or a button
  press). Schedule them a moment later with `$.clock.after`.
- `$.prompt.submit` refuses text starting with `/`. Use `$.command.run` for slash commands.

## Development

```
claude plugin validate plugins/savepoint
claude plugin test plugins/savepoint
```

## License

MIT
