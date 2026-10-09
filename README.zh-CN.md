# claude-prompt-band

在 Claude Code 输入框上方加两行，终端和桌面端都能用。两个可以都装，也可以只装一个。

[English](README.md)

- **goal-meter（任务进度）**：显示 Claude 正在做什么。交给它一个多步的任务，它会自己列出步骤（不用敲任何命令），这一行显示任务名、进度条、完成了几步、还剩多久。鼠标悬停能看到每一步和用时。没列步骤时，悬停显示它最近做的几个操作。计划里起的后台任务（shell、子代理）在跑时，缩进列在当前正在跑的那一步下面（「↳ 任务描述」和它跑了多久），算那一步的，不另计；步骤都标完了它还在跑，才单独算一项：进度显示成「3/4 · 75%」而不是 100%，悬停卡片里列成「后台 · 任务描述」；计划开始前就在跑的，列在最后标「计划外」，不计数。桌面端上这一行宽度固定（和下面的额度那行一样宽），文字变长变短都不挪位置，标题太长会截短；右端固定留一块给其他对话：12 小时内别的对话也有计划时显示「其他对话 N | M 在跑」，悬停它会列出那些对话的项目、目标、进度和还剩多久。做完以后，这一行会保留刚完成的任务和完成时间。
- **usage-band（用量条）**：5 小时和 7 天额度用了多少、什么时候重置，上下文用了多少，缓存命中率。

不管先装哪个，任务进度都在上面，用量条紧贴输入框。

## 安装

```
claude plugin marketplace add neogeweb3/claude-prompt-band
claude plugin install goal-meter@claude-prompt-band
claude plugin install usage-band@claude-prompt-band
```

（在 Claude Code 里也可以用 `/plugin marketplace add neogeweb3/claude-prompt-band`，再 `/plugin install …`。）装好以后新开的对话才有；装之前就开着的对话不会自动加上。

这类插件需要较新的 Claude Code，`claude --version` 2.1.288 实测可用。

## goal-meter 的「还剩多久」怎么算

Claude 列计划时给每一步报一个预计分钟数。每做完一步，剩下的步骤按这个计划里 Claude「估的分钟数总和 ÷ 实际用的总和」来修正（做法来自 evidence-based scheduling）。正在跑的那一步往下倒数；超时以后，按「已经超出多少，就再加多少」来估，绝不当作马上就完。

10 分钟以上的步骤，跑到预计时间的 1/4 时会问 Claude 还要多久；回答改动大就到新估计的 1/4 再问一次，回答没怎么变、或者已经问过两次就不再提前问；超时时再问一次。Claude 在干活时，问题附在它下一次工具调用的结果里；Claude 空闲、在等后台任务时，改为问一个对话分身（同一个模型，走提示缓存，不显示给任何人），每次问的内容和花的 token 记在 `~/.claude/mods-data/goal-meter/asks.jsonl`。`/goals ask off` 关掉这种分身提问。

## 关掉其中一个

```
claude plugin disable goal-meter@claude-prompt-band
claude plugin enable goal-meter@claude-prompt-band
```

也可以在 `/plugin` 里直接开关。usage-band 同理。

## 更新

```
claude plugin marketplace update claude-prompt-band
claude plugin update goal-meter@claude-prompt-band
claude plugin update usage-band@claude-prompt-band
```

## 会存什么、存在哪

不往外发任何数据。goal-meter 把每个对话的计划存在 `~/.claude/mods-data/goal-meter/<对话>.json`（`/goals` 和这一行右边的「其他对话」用它列出所有对话的计划）。usage-band 通过 `~/.claude/usage-band-shared.json` 在开着的对话之间共享最新额度，这样闲着的对话也能显示准确的额度。usage-band 不会自己调用模型。goal-meter 会在系统提示里加一小段，让 Claude 遇到多步任务时列出步骤；Claude 空闲、在等后台任务时，它可能问一个对话分身某一步还要多久（走你自己的账号和用量，每次连同花的 token 记在 `~/.claude/mods-data/goal-meter/asks.jsonl`；`/goals ask off` 关掉）。每做完一步，还会往 `~/.claude/mods-data/goal-meter/ledger.jsonl` 记一行（Claude 报的分钟数、实际用时、模型），只留最近 5000 行，用来看 Claude 估得准不准。

## 致谢

usage-band 原作者 [Jetson Chan](https://github.com/JetsonChan/CC-Usage-Band)，goal-meter 原作者 [Nate Herk](https://github.com/nateherkai/claude-code-mods)，都是 MIT 许可证。本仓库在原版基础上改过：usage-band 让闲着的对话也显示最新额度，并固定在最靠近输入框的位置；goal-meter 改成常驻一行、和 usage-band 同一风格，不用 `/goal` 也会自动列步骤，悬停显示步骤。
