# claude-prompt-band

在 Claude Code 输入框上方加两行，终端和桌面端都能用。两个可以都装，也可以只装一个。

[English](README.md)

- **goal-meter（任务进度）**：显示 Claude 正在做什么。交给它一个多步的任务，它会自己列出步骤（不用敲任何命令），这一行显示任务名、进度条、完成了几步、还剩多久。鼠标悬停能看到每一步和用时。没列步骤时，悬停显示它最近做的几个操作。做完以后，这一行会保留刚完成的任务和完成时间。
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

不往外发任何数据。goal-meter 把每个对话的计划存在 `~/.claude/mods-data/goal-meter/<对话>.json`（`/goals` 用它列出所有对话的计划）。usage-band 通过 `~/.claude/usage-band-shared.json` 在开着的对话之间共享最新额度，这样闲着的对话也能显示准确的额度。两个插件都不会自己调用模型；goal-meter 会在系统提示里加一小段，让 Claude 遇到多步任务时列出步骤。

## 致谢

usage-band 原作者 [Jetson Chan](https://github.com/JetsonChan/CC-Usage-Band)，goal-meter 原作者 [Nate Herk](https://github.com/nateherkai/claude-code-mods)，都是 MIT 许可证。本仓库在原版基础上改过：usage-band 让闲着的对话也显示最新额度，并固定在最靠近输入框的位置；goal-meter 改成常驻一行、和 usage-band 同一风格，不用 `/goal` 也会自动列步骤，悬停显示步骤。
