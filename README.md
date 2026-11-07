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
/plugin install token-saver --marketplace FelixForLyfe/token-saver-mods
```

From a shell:

```
claude plugin install token-saver --marketplace FelixForLyfe/token-saver-mods
```

Set the `notesDir` plugin setting to a folder that exists on your machine (default is `D:/Claude/token-saver-notes`).
