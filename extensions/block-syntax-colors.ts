/**
 * block-syntax-colors — multi-color blocks for Pi
 *
 * Goal: give every kind of block more than one color, without patching Pi.
 *
 * 1. Thinking blocks
 *    Pi renders thinking through Markdown with a flat text style
 *    (`theme.fg("thinkingText", ...)` + italic). Verified on this machine:
 *    that flat style does NOT cover inline code or fenced code, so a markdown
 *    transformer can colorise thinking prose by promoting keywords to inline
 *    code (mdCode) — they then leave the flat color.
 *
 * 2. Fenced blocks with no language
 *    `highlightCode(code)` returns a single flat color when no language is
 *    given (upstream removed cli-highlight auto-detection). So a ``` block
 *    pasted without an info string stays one color. This extension detects the
 *    language and writes it into the info string, which switches the block to
 *    the full syntax palette (keyword/string/function/comment/number...).
 *    Applies to user, assistant and thinking markdown alike.
 *
 * 3. Tool blocks
 *    Default tool results are drawn in a single `toolOutput` color. The `read`,
 *    `bash`, `grep`, `find` and `ls` tools are re-registered with the same name
 *    and the original `execute`, plus a `renderResult` that renders the output
 *    as a fenced block carrying the detected language.
 */

import { appendFileSync } from "node:fs";

import type {
	BashToolDetails,
	ExtensionAPI,
	ReadToolDetails,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadTool,
	getLanguageFromPath,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

/** Lines shown for a collapsed tool result before the user expands it. */
const COLLAPSED_LINES = 12;

/**
 * Opt-in trace. Set `PI_BLOCK_SYNTAX_TRACE=/path/to/file` to append one line per
 * transformer / tool-render invocation. Used to prove the extension is live in a
 * real TUI session; a no-op when the variable is unset.
 */
function trace(event: string, detail: string): void {
	const file = process.env.PI_BLOCK_SYNTAX_TRACE;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} ${event} ${detail}\n`);
	} catch {
		// tracing must never break rendering
	}
}

/** Words promoted to inline code inside thinking prose. */
const THINKING_KEYWORDS = [
	// python
	"def", "class", "return", "import", "from", "elif", "else", "if", "for", "while",
	"try", "except", "finally", "with", "lambda", "yield", "async", "await", "raise",
	"None", "True", "False", "self", "pass", "break", "continue", "global", "assert",
	// javascript / typescript
	"const", "let", "var", "function", "interface", "export",
	// generic prose operators worth marking
	"and", "or", "not", "is", "in",
];

const THINKING_KEYWORD_RE = new RegExp(
	`\\b(${THINKING_KEYWORDS.join("|")})\\b`,
	"g",
);

/** ``` or ~~~ fence opener. */
const FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/** Shell separators that start a new command position. */
const SHELL_SEPARATOR_RE = /^(&&|\|\||>>|>|<|\||;|&)/;
/** `-x`, `--long`, `--opt=value`. */
const SHELL_FLAG_RE = /^--?[A-Za-z0-9][\w-]*(=.*)?$/;
/** `NAME=value` prefix. */
const SHELL_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Wrappers whose next word is still the real command name. */
const SHELL_TRANSPARENT_CMDS = new Set([
	"sudo", "env", "time", "nohup", "xargs", "command", "exec", "then", "do", "else",
]);

/**
 * Colour a shell command line with the theme's syntax palette.
 *
 * Pi's built-in shell call renders `${prompt} ${command}` in one colour
 * (`toolTitle` + bold), so a command like `cd /tmp && ls -la` reads as a single
 * white run. cli-highlight is not a usable substitute here: verified on this
 * machine it colours `cd` and leaves the rest of the line unstyled.
 */
export function highlightShellCommand(command: string, theme: Theme): string {
	const out: string[] = [];
	let atCommandPosition = true;
	let i = 0;

	while (i < command.length) {
		const ch = command[i];

		if (/\s/.test(ch)) {
			out.push(ch);
			i++;
			continue;
		}

		// Comment runs to end of line.
		if (ch === "#") {
			out.push(theme.fg("syntaxComment", command.slice(i)));
			break;
		}

		const separator = SHELL_SEPARATOR_RE.exec(command.slice(i));
		if (separator) {
			out.push(theme.fg("syntaxOperator", separator[0]));
			i += separator[0].length;
			atCommandPosition = true;
			continue;
		}

		// Quoted string, escapes handled.
		if (ch === "'" || ch === '"') {
			const quote = ch;
			let j = i + 1;
			while (j < command.length && command[j] !== quote) {
				if (command[j] === "\\") j++;
				j++;
			}
			j = Math.min(j + 1, command.length);
			out.push(theme.fg("syntaxString", command.slice(i, j)));
			i = j;
			atCommandPosition = false;
			continue;
		}

		let j = i;
		while (
			j < command.length &&
			!/[\s|;&<>]/.test(command[j]) &&
			command[j] !== "'" &&
			command[j] !== '"'
		) {
			j++;
		}
		const word = command.slice(i, j);
		i = j;

		if (SHELL_ASSIGN_RE.test(word)) {
			const eq = word.indexOf("=");
			out.push(
				theme.fg("syntaxVariable", word.slice(0, eq)) +
					theme.fg("syntaxOperator", "=") +
					theme.fg("syntaxString", word.slice(eq + 1)),
			);
			continue;
		}

		if (atCommandPosition) {
			out.push(theme.fg("syntaxFunction", word));
			atCommandPosition = SHELL_TRANSPARENT_CMDS.has(word);
			continue;
		}

		if (SHELL_FLAG_RE.test(word)) {
			out.push(theme.fg("syntaxKeyword", word));
			continue;
		}
		if (/^-?\d+$/.test(word)) {
			out.push(theme.fg("syntaxNumber", word));
			continue;
		}
		if (word.startsWith("$") || word.startsWith("${")) {
			out.push(theme.fg("syntaxVariable", word));
			continue;
		}
		if (
			word.includes("/") ||
			word.startsWith("~") ||
			word.includes(".") ||
			/^https?:/.test(word)
		) {
			out.push(theme.fg("syntaxString", word));
			continue;
		}

		out.push(word);
	}

	return out.join("");
}

/**
 * Guess a cli-highlight language name from block content.
 *
 * Deliberately conservative: returning undefined keeps the block in its flat
 * `mdCodeBlock` color, which is better than mislabeling prose.
 */
export function detectLanguage(code: string): string | undefined {
	const text = code.trim();
	if (!text) return undefined;

	// Structured data.
	if (/^[[{][\s\S]*[\]}]$/.test(text)) {
		try {
			JSON.parse(text);
			return "json";
		} catch {
			// not JSON, keep guessing
		}
	}

	// Unified diff.
	if (/^(diff --git|@@ )/m.test(text) || /^\+\+\+ /m.test(text)) return "diff";

	if (/^(#!.*\b(bash|sh|zsh)\b|\$\s+\S)/m.test(text)) return "bash";

	if (/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i.test(text)) {
		return "sql";
	}

	// Python: def/class with a body, or import lines, or decorators.
	if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(text)) return "python";
	if (/^\s*(import\s+\w|from\s+[\w.]+\s+import\s)/m.test(text)) return "python";
	if (/^\s*(@\w+(\.\w+)*\s*$|async\s+def\s+\w+)/m.test(text)) return "python";

	// JS/TS: arrow functions, const/let with a value, function declarations.
	if (/(=>|^\s*(const|let)\s+\w+\s*=|^\s*(export\s+)?(async\s+)?function\s+\w+\s*\()/m.test(text)) {
		return "typescript";
	}

	// YAML: `key: value` lines with no braces or semicolons.
	if (
		/^[A-Za-z_][\w.-]*:\s+\S/m.test(text) &&
		!/[{};]/.test(text) &&
		/^(\s*[-#]|\s*[\w.-]+:)/m.test(text)
	) {
		return "yaml";
	}

	// Shell-ish: shell verbs at line start.
	if (
		/^\s*(git|npm|pnpm|yarn|uv|pip|docker|kubectl|cd|ls|cat|grep|rg|find|chmod|mkdir|rm|mv|cp|export)\b/m.test(
			text,
		)
	) {
		return "bash";
	}

	return undefined;
}

/**
 * Write a detected language into fence openers that have no info string.
 * Line-based, so a streaming (unterminated) fence is left untouched.
 */
export function autoTagFences(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const open = FENCE_OPEN_RE.exec(lines[i]);
		if (!open) {
			out.push(lines[i]);
			i++;
			continue;
		}

		const [, indent, marker, info] = open;
		const char = marker[0] === "`" ? "`" : "~";
		const closeRe = new RegExp(`^[ \\t]*${char}{${marker.length},}[ \\t]*$`);

		const body: string[] = [];
		let j = i + 1;
		while (j < lines.length && !closeRe.test(lines[j])) {
			body.push(lines[j]);
			j++;
		}

		// Unterminated fence: still streaming, emit the rest verbatim.
		if (j >= lines.length) {
			out.push(...lines.slice(i));
			break;
		}

		const declared = info.trim().split(/\s+/)[0] ?? "";
		const language = declared || detectLanguage(body.join("\n")) || "";
		out.push(`${indent}${marker}${declared ? info : language}`);
		out.push(...body);
		out.push(lines[j]);
		i = j + 1;
	}

	return out.join("\n");
}

/**
 * Promote language keywords in prose to inline code so they pick up `mdCode`
 * instead of the flat thinking color. Existing inline code is left alone.
 */
export function colorizeThinkingProse(markdown: string): string {
	return markdown
		.split(/(`[^`\n]*`)/)
		.map((segment, index) => {
			if (index % 2 === 1) return segment; // pre-existing inline code
			return segment.replace(THINKING_KEYWORD_RE, (word) => `\`${word}\``);
		})
		.join("");
}

/** Apply the whole transform, fence-aware. */
export function transformMarkdown(markdown: string, messageType: string): string {
	const tagged = autoTagFences(markdown);
	if (messageType !== "assistant-thinking") return tagged;

	// Colourise prose only; fenced bodies are passed through untouched.
	return tagged
		.split(/(^[ \t]*(?:`{3,}|~{3,})[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[ \t]*$)/m)
		.map((segment, index) => {
			if (index % 2 === 1) return segment;
			return colorizeThinkingProse(segment);
		})
		.join("");
}

/** Take the first N lines unless the user expanded the result. */
function preview(text: string, expanded: boolean): { body: string; hidden: number } {
	const trimmed = text.replace(/\s+$/, "");
	if (expanded) return { body: trimmed, hidden: 0 };
	const lines = trimmed.split("\n");
	if (lines.length <= COLLAPSED_LINES) return { body: trimmed, hidden: 0 };
	return {
		body: lines.slice(0, COLLAPSED_LINES).join("\n"),
		hidden: lines.length - COLLAPSED_LINES,
	};
}

/** Render text as a fenced block so the markdown renderer colors it. */
function codeBlock(text: string, language: string | undefined): Markdown {
	const fence = language ? `\`\`\`${language}` : "```";
	return new Markdown(`${fence}\n${text}\n\`\`\``, 1, 0, getMarkdownTheme());
}

/** Append muted footer notes under a block. */
function withNotes(block: Markdown, theme: Theme, notes: string[]): Markdown | Container {
	if (notes.length === 0) return block;
	const container = new Container();
	container.addChild(block);
	container.addChild(new Text(notes.map((note) => theme.fg("muted", note)).join("\n"), 1, 0));
	return container;
}

/** Extract the text payload of a tool result. */
function textOf(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
	const first = result.content?.[0];
	return first?.type === "text" ? first.text : undefined;
}

/**
 * The shell call/result renderers shared by bash and powershell.
 *
 * The built-in pair renders the whole `${prompt} ${command}` in one colour and
 * the result in flat `toolOutput`; both are replaced here.
 */
function shellRenderers(prompt: string) {
	return {
		renderCall(
			args: { command?: string; timeout?: number } | undefined,
			theme: Theme,
		) {
			const command = String(args?.command ?? "");
			const body = command
				? highlightShellCommand(command, theme)
				: theme.fg("toolOutput", "…");
			let text = theme.fg("toolTitle", theme.bold(prompt)) + body;
			if (args?.timeout) text += theme.fg("muted", ` (timeout ${args.timeout}s)`);
			return new Text(text, 0, 0);
		},
		renderResult(
			result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
			{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
			theme: Theme,
		) {
			if (isPartial) return new Text(theme.fg("warning", "Running…"), 0, 0);
			const text = textOf(result);
			if (text === undefined) return new Text(theme.fg("error", "No output"), 0, 0);

			const { body, hidden } = preview(text, expanded);
			const details = result.details as BashToolDetails | undefined;
			const language = detectLanguage(body) ?? "bash";
			trace("renderResult", `shell lang=${language} lines=${body.split("\n").length}`);

			const notes: string[] = [];
			if (hidden > 0) notes.push(`… ${hidden} more lines (ctrl+e)`);
			if (details?.truncation?.truncated) {
				notes.push(`truncated from ${details.truncation.totalLines} lines`);
			}
			if (details?.fullOutputPath) notes.push(`full output: ${details.fullOutputPath}`);

			return withNotes(codeBlock(body, language), theme, notes);
		},
	};
}

export default function blockSyntaxColors(pi: ExtensionAPI): void {
	// ---------------------------------------------------------------- markdown
	pi.registerMarkdownTransformer((markdown, context) => {
		const transformed = transformMarkdown(markdown, context.messageType);
		trace(
			"transform",
			`type=${context.messageType} in=${markdown.length} out=${transformed.length} changed=${transformed !== markdown}`,
		);
		return transformed;
	});

	// ------------------------------------------------------------------- tools
	const cwd = process.cwd();

	// read — highlight by file extension.
	const read = createReadTool(cwd);
	pi.registerTool({
		...read,
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);
			const text = textOf(result);
			if (text === undefined) return new Text(theme.fg("success", "Image loaded"), 0, 0);

			const { body, hidden } = preview(text, expanded);
			const language = getLanguageFromPath(String(context.args?.path ?? ""));
			const details = result.details as ReadToolDetails | undefined;
			trace("renderResult", `tool=read lang=${language} lines=${body.split("\n").length}`);

			const notes: string[] = [];
			if (hidden > 0) notes.push(`… ${hidden} more lines (ctrl+e)`);
			if (details?.truncation?.truncated) {
				notes.push(`truncated from ${details.truncation.totalLines} lines`);
			}

			return withNotes(codeBlock(body, language), theme, notes);
		},
	});

	// bash — highlight the output, falling back to bash.
	const bash = createBashTool(cwd);
	pi.registerTool({ ...bash, ...shellRenderers("$ ") });

	// grep — matches, no coloring language.
	const grep = createGrepTool(cwd);
	pi.registerTool({
		...grep,
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
			const text = textOf(result);
			if (text === undefined) return new Text(theme.fg("muted", "No matches"), 0, 0);

			const { body, hidden } = preview(text, expanded);
			trace("renderResult", `tool=grep lines=${body.split("\n").length}`);
			const notes: string[] = [];
			if (hidden > 0) notes.push(`… ${hidden} more lines (ctrl+e)`);
			return withNotes(codeBlock(body, undefined), theme, notes);
		},
	});

	// find — file paths.
	const find = createFindTool(cwd);
	pi.registerTool({
		...find,
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
			const text = textOf(result);
			if (text === undefined) return new Text(theme.fg("muted", "No files"), 0, 0);

			const { body, hidden } = preview(text, expanded);
			trace("renderResult", `tool=find lines=${body.split("\n").length}`);
			const notes: string[] = [];
			if (hidden > 0) notes.push(`… ${hidden} more entries (ctrl+e)`);
			return withNotes(codeBlock(body, undefined), theme, notes);
		},
	});

	// ls — directory entries.
	const ls = createLsTool(cwd);
	pi.registerTool({
		...ls,
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Listing…"), 0, 0);
			const text = textOf(result);
			if (text === undefined) return new Text(theme.fg("muted", "Empty"), 0, 0);

			const { body, hidden } = preview(text, expanded);
			trace("renderResult", `tool=ls lines=${body.split("\n").length}`);
			const notes: string[] = [];
			if (hidden > 0) notes.push(`… ${hidden} more entries (ctrl+e)`);
			return withNotes(codeBlock(body, undefined), theme, notes);
		},
	});

	// powershell has the identical monochrome defect (`formatShellCall`) but it is not
	// part of `createCodingTools`, so colour it only when the runtime already exposes
	// the tool — otherwise this would add a phantom tool the user never enabled.
	// `getAllTools()` throws during the factory and may throw again if the runtime
	// is not ready, so defer and never let a rendering nicety break the session.
	pi.on("session_start", () => {
		try {
			const names = pi.getAllTools().map((tool) => tool.name);
			if (!names.includes("powershell")) return;
			pi.registerTool({ ...createPowerShellTool(cwd), ...shellRenderers("PS> ") });
		} catch {
			// leave the built-in powershell renderer in place
		}
	});
}
