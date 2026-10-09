# claude-prompt-band

Two rows above the Claude Code prompt, in the terminal and the desktop app. Install either or both.

[中文说明](README.zh-CN.md)

- **goal-meter**: what Claude is working on. When you hand Claude a task with several steps, it lists the steps on its own (no command needed) and the row shows the task's title, a progress bar, steps done of total and the time left. Hover the row for every step with its time. With no plan, it shows Claude's latest operations instead. Background work (a shell or agent) the plan started is listed under the step running now (↳, with its time) and not counted; once every step is done while it still runs, it counts as a step of its own: the row reads 3/4 · 75%, not 100%, and the card lists it as 后台 · <description>; work running since before the plan began is listed last as 计划外 and never counted. On the desktop the row is one fixed width (as wide as the usage band beneath it), so it never shifts as its text changes; a long title is cut to fit. Its right end is kept for other chats: when they had a plan in the last 12 hours it reads "其他对话 N | M 在跑"; hover it for each chat's project, goal, progress and time left. When the work is done, the row keeps the finished task and how long ago it finished.
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

## How goal-meter's time left works

Claude gives every step its minutes when it lists the plan. As steps finish, the steps left are scaled by how Claude's estimates have held up in this plan (all the minutes it estimated for the finished steps against all they really took), the way evidence-based scheduling does it. The running step counts down; once it is late it is taken to need as long again as it has overrun, never to be nearly done.

For a step of ten minutes or more, goal-meter asks Claude how much longer a quarter of the way in, and once more after an answer that moved the finish a lot; it stops after an answer that kept it, or after two asks, and asks again once a step is late. While Claude works, the question rides on its next tool call. While it sits idle waiting on background work, a fork of the conversation is asked instead (same model, served from the prompt cache, shown to no one); each such ask and its token count goes into `~/.claude/mods-data/goal-meter/asks.jsonl`. `/goals ask off` turns those forks off.

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

Nothing leaves your machine. goal-meter writes each chat's plan to `~/.claude/mods-data/goal-meter/<session>.json` (so `/goals`, and the "other chats" area at the right end of the row, can list every chat's plan). usage-band shares the latest limit reading between open chats through `~/.claude/usage-band-shared.json`, so an idle chat's band stays current. usage-band sends no model requests of its own. goal-meter adds one short section to the system prompt asking Claude to plan multi-step work, and while Claude waits idle on background work it may ask a fork of the conversation how much longer a step has (on your own account and usage, logged with its token count in `~/.claude/mods-data/goal-meter/asks.jsonl`; `/goals ask off` stops it). Each finished step also adds a line (what Claude said, what it took, the model) to `~/.claude/mods-data/goal-meter/ledger.jsonl`, the last 5000 kept, for checking how Claude's estimates hold up.

## Credits

usage-band is by [Jetson Chan](https://github.com/JetsonChan/CC-Usage-Band); goal-meter is by [Nate Herk](https://github.com/nateherkai/claude-code-mods). Both MIT. This repository reworks them: usage-band keeps idle chats' limits current and stays nearest the prompt; goal-meter became an always-on row in usage-band's style, plans without `/goal`, and shows steps on hover.

## Develop

```
claude plugin validate goal-meter && claude plugin test goal-meter
claude plugin validate usage-band && claude plugin test usage-band
```
