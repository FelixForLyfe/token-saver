# token-saver

A Claude Code mod that keeps weekly token usage down and adds a compact usage bar above the prompt.

- Compacts the conversation early (default 150k tokens) and saves a notes file so nothing important is lost
- Routes routine steps to a cheaper model (Sonnet or Haiku), with a Boost toggle for hard work
- Caps reasoning effort, trims subagent cost, and refuses forks of huge sessions
- Usage bar (context, 5-hour, weekly) with a Settings menu; `/saver` prints the full report in chat
- Pacing toast when weekly usage runs ahead of an even pace

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install token-saver --marketplace FelixForLyfe/token-saver
```

From a shell:

```
claude plugin install token-saver --marketplace FelixForLyfe/token-saver
```

Set the `notesDir` plugin setting to a folder that exists on your machine (default is `D:/Claude/token-saver-notes`).

## Docs and license

How it works: https://felixforlyfe.github.io/token-saver/

MIT licensed, see [LICENSE](LICENSE). Contributions welcome.

## Finding what fills your context

- `/saver-load` lists what the window carries before you type: system prompt, connectors, skills, memory files, with token counts.
- `/saver-off <folder>` moves a skill folder from `~/.claude/skills` to `D:\Claude\skills-off`; `/saver-on <folder>` moves it back. Nothing is deleted. Run `/reload-plugins` afterwards.
- Connectors can't be switched from a mod. Turn them off in the app's connector settings.
