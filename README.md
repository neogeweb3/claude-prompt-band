# claude-prompt-band

Two rows above the Claude Code prompt, in the terminal and the desktop app. Install either or both.

[中文说明](README.zh-CN.md)

- **goal-meter**: what Claude is working on. When you hand Claude a task with several steps, it lists the steps on its own (no command needed) and the row shows the task's title, a progress bar, steps done of total and the time left. Hover the row for every step with its time. With no plan, it shows Claude's latest operations instead. When the work is done, the row keeps the finished task and how long ago it finished.
- **usage-band**: your 5-hour and 7-day limits with their reset times, the context window, and the prompt-cache hit rate.

goal-meter sits on top, usage-band right above the prompt, whichever you install first.

## Install

```
claude plugin marketplace add neogeweb3/claude-prompt-band
claude plugin install goal-meter@claude-prompt-band
claude plugin install usage-band@claude-prompt-band
```

(Inside Claude Code: `/plugin marketplace add neogeweb3/claude-prompt-band`, then `/plugin install …`.) New chats pick them up; a chat already open before the install does not.

Hooks modules (the kind of plugin these are) need a recent Claude Code; `claude --version` 2.1.288 is known to work.

## Turn one off

```
claude plugin disable goal-meter@claude-prompt-band
claude plugin enable goal-meter@claude-prompt-band
```

Or use `/plugin` and toggle it there. Same for `usage-band`.

## Update

```
claude plugin marketplace update claude-prompt-band
claude plugin update goal-meter@claude-prompt-band
claude plugin update usage-band@claude-prompt-band
```

## What they keep, and where

Nothing leaves your machine. goal-meter writes each chat's plan to `~/.claude/mods-data/goal-meter/<session>.json` (so `/goals` can list every chat's plan). usage-band shares the latest limit reading between open chats through `~/.claude/usage-band-shared.json`, so an idle chat's band stays current. Neither sends model requests of its own; goal-meter adds one short section to the system prompt asking Claude to plan multi-step work.

## Credits

usage-band is by [Jetson Chan](https://github.com/JetsonChan/CC-Usage-Band); goal-meter is by [Nate Herk](https://github.com/nateherkai/claude-code-mods). Both MIT. This repository reworks them: usage-band keeps idle chats' limits current and stays nearest the prompt; goal-meter became an always-on row in usage-band's style, plans without `/goal`, and shows steps on hover.

## Develop

```
claude plugin validate goal-meter && claude plugin test goal-meter
claude plugin validate usage-band && claude plugin test usage-band
```
