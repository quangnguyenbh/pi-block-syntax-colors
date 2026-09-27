# pi-block-syntax-colors

Multi-color blocks for [Pi](https://pi.dev): syntax-highlighted **shell/tool call lines**, **fenced tool output**, and **thinking text**.

Pi already syntax-highlights code fences — but three things it draws in a single flat color:

1. **Shell call lines.** `formatShellCall` wraps the whole `$ command` in one color, so `cd /tmp/x && ls -la` renders as one white run.
2. **Fenced blocks with no language.** `highlightCode(code)` only highlights when you pass a language; a ``` block pasted without an info string stays one color.
3. **Thinking text.** Pi draws thinking with a flat `thinkingText` + italic style, so keywords never get color.

This package fixes all three using only public Pi APIs — no patching, no fork.

## Before / after

```
$ cd /tmp/qnbh-ext && ls -la
  ↑               ↑      ↑  ↑
  one color ──────────────────────────✦
```

After installing, the same line renders like this (colors are your theme's `syntax*` tokens):

| Part | Token | Example in `later-this-evening` |
|---|---|---|
| command name (`cd`, `ls`, `git`, `uv`, …) | `syntaxFunction` | purple |
| flags (`-la`, `--short`) | `syntaxKeyword` | gold |
| paths, URLs, quoted strings | `syntaxString` | teal |
| operators (`&&`, `\|\|`, `\|`, `>`, `>>`, `;`, `&`) | `syntaxOperator` | red |
| `VAR=value` | `syntaxVariable` | muted |
| `# comment` | `syntaxComment` | dim |

## Install

From a Git source (recommended — pins to a tag or commit):

```bash
pi install git:github.com/quangnguyenbh/pi-block-syntax-colors@v1.0.2
```

From a local checkout:

```bash
pi install ./pi-block-syntax-colors
```

Try it for one run without touching your settings:

```bash
pi -e git:github.com/quangnguyenbh/pi-block-syntax-colors
```

> Run `-e` only while the package is **not** installed. Pi identifies a git package by repository URL without the ref, so an installed `@vX.Y.Z` and an unpinned `-e` clone are two identities that each register the same tools — Pi then reports `Tool "read" conflicts with …` and loads neither. `pi remove` first.

Then **`/reload`** or restart Pi. Pi loads extensions at startup, so a running session will not pick up a new package until it reloads.

Verify it is live:

```bash
PI_BLOCK_SYNTAX_TRACE=/tmp/pi-colors.log pi
# then, in another shell:
grep renderResult /tmp/pi-colors.log
```

A `renderResult shell lang=…` line means the extension is active.

## What it does

### 1. Shell call lines (`bash`, `powershell`)

Re-registers both tools with a custom `renderCall` that tokenizes the command line with the theme's `syntax*` palette. Quoting (single, double), `VAR=value`, and wrappers that keep command position (`sudo`, `env`, `time`, `nohup`, `xargs`, `command`, `exec`, `then`, `do`, `else`) are handled. Streaming renders progressively, so a command being typed by the model gains color as arguments arrive.

`powershell` is only re-registered when your runtime already exposes the tool, so this package never adds a phantom tool you did not enable.

### 2. Tool result bodies (`read`, `bash`, `powershell`, `grep`, `find`, `ls`)

Re-registers the same tools (original `execute` preserved) with a `renderResult` that draws the output as a fenced code block:

- `read` → language from the file extension (`getLanguageFromPath`)
- `bash` / `powershell` → language detected from the output, falling back to `bash`
- `grep` / `find` / `ls` → plain fence

Long output collapses to 12 lines with a `… N more lines (ctrl+e)` note; truncation and `fullOutputPath` details are preserved.

`edit` and `write` are deliberately **not** touched, so Pi's built-in diff coloring (red/green) keeps working.

### 3. Fenced blocks with no language

A markdown transformer detects the language of every language-less fence (`python`, `typescript`, `javascript`, `json`, `yaml`, `bash`, `sql`, `diff`) and writes it into the info string. Detection is deliberately conservative: if it cannot tell, the block is left alone rather than mislabeled.

Applies to **user**, **assistant**, and **thinking** markdown. Streaming (unterminated) fences are passed through untouched.

### 4. Thinking blocks

For `assistant-thinking` markdown only, language keywords (`def`, `return`, `None`, `self`, `if`, `for`, `const`, `await`, …) are promoted to inline code so they escape the flat `thinkingText` style and pick up `mdCode`. Fenced bodies and pre-existing inline code are never rewritten.

## Compatibility

- Pi `0.87.x` or newer. Uses `pi.registerMarkdownTransformer`, `pi.registerTool`, `pi.getAllTools`, and `pi.on("session_start")`.
- Colors come from your **theme**, not hardcoded values. Any theme that defines the `syntax*`, `md*`, and `thinkingText` tokens works; themes built for Pi all do.
- macOS, Linux, Windows — no platform-specific code.

### Known limitation

Tools registered by other packages that ship **no** `renderCall` fall back to Pi's `createCallFallback()`, which draws the bare tool name in one color. In practice this affects control tools such as `typesafe_question` and `goal_complete` / `goal_blocked` / `goal_wait` (their packages do not register a renderer).

It cannot be fixed from an extension, for verified reasons:

- `pi.registerTool` replaces a tool definition wholesale (`Map.set`), and the definition returned by `pi.getAllTools()` does not include `execute` — re-registering would break the tool.
- The packages that own those tools do not export their definitions.
- Patching `ToolExecutionComponent.prototype` does not work: `pi` runs the bundled build (`dist/bundle/cli.js`) while extensions resolve `@earendil-works/pi-coding-agent` to the modular build (`dist/index.js`), so they are different class objects.

Packages that **do** ship a `renderCall` (for example `pi-subagents`, `@pinet/slack-bridge`) are unaffected and already render in color.

## How it works

Three public extension APIs, no patching:

| API | Used for |
|---|---|
| `pi.registerMarkdownTransformer` | fence auto-tagging + thinking keyword coloring |
| `pi.registerTool` | `renderCall` / `renderResult` for the shell and read-only tools |
| `pi.on("session_start")` | conditional `powershell` registration |

Nothing is written outside the extension: no config, no state, no network calls.

## License

MIT
