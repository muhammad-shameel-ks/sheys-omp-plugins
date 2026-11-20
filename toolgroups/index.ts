/**
 * Tool groups for oh-my-pi: each run of tool calls between two pieces of
 * assistant text collapses into one summary row, Claude Code style:
 *
 *   • 11 commands, 6 thoughts, 4 reads, 2 tools  (ctrl+o to expand)
 *
 * Built on the public transcript presenter API (`pi.registerTranscriptPresenter`),
 * so omp itself handles redraws and scrollback replays; no internals are patched.
 * The first call of a group draws the summary, the others draw nothing. While the
 * agent is still working, the newest call also shows as omp's own one-row summary
 * so live progress stays visible. A group of one call shows omp's one-row summary.
 * Ctrl+O expands every block to full, as without the plugin.
 *
 * Edits, writes, subagent tasks, questions and todo updates are never grouped:
 * they draw in full and end the group, so changes stay readable in the transcript.
 *
 * Presenters run only while the `extensionRenderers.transcriptPresenters`
 * setting is on (off by default); `/toolgroups on` turns it on.
 *
 * Two extras go beyond the public API:
 * - Usage rows (`display.showTokenUsage`) of requests that ended in tool calls
 *   are hidden, so a turn keeps one stats row under its final answer. omp adds
 *   no hook for them, so this patches pi-tui internals; the modules are loaded
 *   behind a guard, so an omp release that moves them only turns this part off.
 * - While a group is live, its summary shimmers. Only under the fullscreen
 *   plugin, where blocks are drawn fresh every frame: in the normal screen each
 *   frame could make omp replay the scrollback.
 */
import {
	cfgExtensionTranscriptPresenters,
	type ExtensionAPI,
	type ExtensionContext,
	settings,
} from "@oh-my-pi/pi-coding-agent";
import { shimmerEnabled } from "@oh-my-pi/pi-tui";

/** Tools that draw in full and end the group they follow. */
const UNGROUPED = new Set([
	"edit",
	"write",
	"ast_edit",
	"apply_patch",
	"task",
	"ask",
	"todo",
	"todo_write",
]);

type Category = "commands" | "reads" | "searches" | "tools";

/** Display order of the counts in the summary row; thoughts follow commands, as in Claude Code. */
const CATEGORY_OF: Record<string, Category> = {
	bash: "commands",
	eval: "commands",
	read: "reads",
	grep: "searches",
	glob: "searches",
	find: "searches",
	ast_grep: "searches",
	web_search: "searches",
	recall: "searches",
};

const NOUNS: Record<Category | "thoughts" | "failed", [string, string]> = {
	commands: ["command", "commands"],
	thoughts: ["thought", "thoughts"],
	reads: ["read", "reads"],
	searches: ["search", "searches"],
	tools: ["tool", "tools"],
	failed: ["failed", "failed"],
};

interface Group {
	readonly ids: string[];
	readonly names: string[];
	thoughts: number;
	/** Opened with a click: every call draws in full. */
	expanded: boolean;
}

interface ContentPart {
	readonly type: string;
	readonly id?: string;
	readonly name?: string;
	readonly text?: string;
}

interface MessageLike {
	readonly role: string;
	readonly content?: unknown;
	readonly toolCallId?: string;
	readonly isError?: boolean;
	readonly display?: boolean;
}

function isGroupable(toolName: string): boolean {
	return !UNGROUPED.has(toolName);
}

function plural(count: number, [one, many]: [string, string]): string {
	return `${count} ${count === 1 ? one : many}`;
}

function contentParts(message: MessageLike): readonly ContentPart[] {
	return Array.isArray(message.content) ? (message.content as ContentPart[]) : [];
}

/**
 * Walks the conversation in order and assigns tool calls to groups. Assistant
 * messages are fed part by part, so a streaming message can be fed again as it
 * grows: parts already decided are skipped.
 */
class Grouper {
	readonly groupOf = new Map<string, Group>();
	readonly failed = new Set<string>();
	/** The group still taking calls; `undefined` once text or a full block ended it. */
	current: Group | undefined;
	/** Thoughts seen since the last group ended, before the next call opens one. */
	#pendingThoughts = 0;
	/** Parts of the streaming assistant message already decided. */
	#decided = 0;

	reset(): void {
		this.groupOf.clear();
		this.failed.clear();
		this.current = undefined;
		this.#pendingThoughts = 0;
		this.#decided = 0;
	}

	/** End the current group; returns its newest call, which stops being the live one. */
	#close(): string[] {
		const last = this.current?.ids.at(-1);
		this.current = undefined;
		this.#pendingThoughts = 0;
		return last === undefined ? [] : [last];
	}

	/** Start of a new message: the part cursor belongs to one assistant message. */
	beginMessage(): void {
		this.#decided = 0;
	}

	/**
	 * Feed `message` (complete, or a streaming snapshot of the assistant message
	 * last begun). Returns the ids whose display may have changed.
	 */
	feed(message: MessageLike): string[] {
		switch (message.role) {
			case "assistant":
				return this.#feedAssistant(message);
			case "toolResult": {
				const id = message.toolCallId;
				if (id === undefined || !message.isError || this.failed.has(id)) return [];
				this.failed.add(id);
				const group = this.groupOf.get(id);
				return group ? [group.ids[0]!] : [];
			}
			case "custom":
			case "hookMessage":
				// A shown extension message is a block of its own; a hidden one draws nothing.
				return message.display !== false ? this.#close() : [];
			case "user":
			case "bashExecution":
			case "pythonExecution":
			case "compactionSummary":
			case "branchSummary":
				return this.#close();
			default:
				return [];
		}
	}

	#feedAssistant(message: MessageLike): string[] {
		const parts = contentParts(message);
		const changed: string[] = [];
		while (this.#decided < parts.length) {
			const part = parts[this.#decided]!;
			if (part.type === "text") {
				// Text is drawn between the calls, so it ends the group once it has words.
				// An empty text part may still fill in: decide it on a later snapshot.
				if ((part.text ?? "").trim() === "") {
					if (this.#decided === parts.length - 1) break;
				} else {
					changed.push(...this.#close());
				}
			} else if (part.type === "thinking" || part.type === "redactedThinking") {
				if (this.current) {
					this.current.thoughts++;
					changed.push(this.current.ids[0]!);
				} else {
					this.#pendingThoughts++;
				}
			} else if (part.type === "toolCall") {
				// The id arrives with the part's start; wait for it otherwise.
				if (!part.id) break;
				changed.push(...this.#addCall(part.id, part.name ?? ""));
			}
			this.#decided++;
		}
		return changed;
	}

	#addCall(id: string, name: string): string[] {
		if (this.groupOf.has(id)) return [];
		if (!isGroupable(name)) return this.#close();
		let group = this.current;
		const changed = [id];
		if (group) {
			changed.push(group.ids[0]!, group.ids.at(-1)!);
		} else {
			group = { ids: [], names: [], thoughts: this.#pendingThoughts, expanded: false };
			this.#pendingThoughts = 0;
			this.current = group;
		}
		group.ids.push(id);
		group.names.push(name);
		this.groupOf.set(id, group);
		return changed;
	}
}

type Span = { t: string; s?: string };

/** Milliseconds for the shimmer band to cross the text, then the pause before the next sweep. */
const SHIMMER_SWEEP_MS = 1400;
const SHIMMER_PAUSE_MS = 500;
const SHIMMER_FRAME_MS = 80;

/**
 * `text` with a bright band sweeping left to right over dim text: the band's
 * centre in the default foreground, its edges muted.
 */
function shimmerSpans(text: string, now: number): Span[] {
	const band = 3;
	const travel = text.length + band * 2;
	const at = now % (SHIMMER_SWEEP_MS + SHIMMER_PAUSE_MS);
	const centre = at < SHIMMER_SWEEP_MS ? (at / SHIMMER_SWEEP_MS) * travel - band : Number.NEGATIVE_INFINITY;
	const spans: Span[] = [];
	for (let index = 0; index < text.length; index++) {
		const distance = Math.abs(index - centre);
		const s = distance <= 1 ? undefined : distance <= band ? "muted" : "dim";
		const last = spans.at(-1);
		if (last && last.s === s) last.t += text[index];
		else spans.push(s === undefined ? { t: text[index]! } : { t: text[index]!, s });
	}
	return spans;
}

/** The summary row: counts by kind, failures, and the expand hint; `shimmerAt` animates the counts. */
function summaryLabel(group: Group, failed: ReadonlySet<string>, clickable: boolean, shimmerAt?: number): Span[] {
	const counts: Record<Category, number> = { commands: 0, reads: 0, searches: 0, tools: 0 };
	for (const name of group.names) counts[CATEGORY_OF[name] ?? "tools"]++;
	const pieces: string[] = [];
	if (counts.commands > 0) pieces.push(plural(counts.commands, NOUNS.commands));
	if (group.thoughts > 0) pieces.push(plural(group.thoughts, NOUNS.thoughts));
	for (const category of ["reads", "searches", "tools"] as const) {
		if (counts[category] > 0) pieces.push(plural(counts[category], NOUNS[category]));
	}
	const text = pieces.join(", ");
	const spans: Span[] = shimmerAt === undefined ? [{ t: text, s: "muted" }] : shimmerSpans(text, shimmerAt);
	const failures = group.ids.filter(id => failed.has(id)).length;
	if (failures > 0) spans.push({ t: ", ", s: "muted" }, { t: plural(failures, NOUNS.failed), s: "error" });
	spans.push({ t: clickable ? "  (click or ctrl+o to expand)" : "  (ctrl+o to expand)", s: "dim" });
	return spans;
}

interface StatsState {
	patched: boolean;
	/** Hide usage rows of requests that ended in tool calls. */
	hide: boolean;
	/** Usage rows added below their request's tool blocks. */
	readonly intermediate: WeakSet<object>;
}

// Shared across module re-evaluations (extension reloads) so the prototypes are patched once.
const STATS_KEY = Symbol.for("sheys-omp-plugins.toolgroups.stats");
const statsGlobals = globalThis as typeof globalThis & { [STATS_KEY]?: StatsState };
const stats: StatsState = (statsGlobals[STATS_KEY] ??= {
	patched: false,
	hide: process.env.OMP_TOOLGROUPS_STATS !== "all",
	intermediate: new WeakSet(),
});

type RenderFn = (this: object, width: number) => readonly string[];

/**
 * omp adds a usage row after each request: below its tool blocks when the request
 * called tools, below its text when it ended the turn. Tag a row as intermediate
 * when a tool block sits between it and the previous row or user message, and
 * draw tagged rows as nothing.
 */
async function installStatsPatch(): Promise<boolean> {
	if (stats.patched) return true;
	try {
		const [transcript, usage, tools, reads, user] = await Promise.all([
			import("@oh-my-pi/pi-tui/chrome/transcript-container"),
			import("@oh-my-pi/pi-tui/overlays/usage-row"),
			import("@oh-my-pi/pi-tui/chat/tool-execution"),
			import("@oh-my-pi/pi-tui/chat/read-tool-group"),
			import("@oh-my-pi/pi-tui/chat/user-message"),
		]);
		const { TranscriptContainer } = transcript;
		const { isUsageRowBlock } = usage;
		const toolClasses = [tools.ToolExecutionComponent, reads.ReadToolGroupComponent];
		const { UserMessageComponent } = user;
		if (
			typeof TranscriptContainer?.prototype?.addChild !== "function" ||
			typeof isUsageRowBlock !== "function" ||
			toolClasses.some(cls => typeof cls !== "function") ||
			typeof UserMessageComponent !== "function"
		) {
			return false;
		}
		if (stats.patched) return true;
		stats.patched = true;

		const patchedRenders = new WeakSet<object>();
		const addChild = TranscriptContainer.prototype.addChild;
		TranscriptContainer.prototype.addChild = function (this: InstanceType<typeof TranscriptContainer>, component) {
			if (isUsageRowBlock(component)) {
				const children = this.children;
				for (let index = children.length - 1; index >= 0; index--) {
					const child = children[index]!;
					if (isUsageRowBlock(child) || child instanceof UserMessageComponent) break;
					if (toolClasses.some(cls => child instanceof cls)) {
						stats.intermediate.add(component);
						break;
					}
				}
				const proto = Object.getPrototypeOf(component) as { render: RenderFn };
				if (!patchedRenders.has(proto)) {
					patchedRenders.add(proto);
					const render = proto.render;
					proto.render = function (this: object, width: number) {
						if (stats.hide && stats.intermediate.has(this)) return [];
						return render.call(this, width);
					};
				}
			}
			return addChild.call(this, component);
		};
		return true;
	} catch {
		return false;
	}
}

/** Plain transcript clicks, dispatched by the fullscreen plugin (see `TranscriptClickHandler` there). */
type TranscriptClickHandler = (block: object, row: number) => boolean;
const CLICK_KEY = Symbol.for("sheys-omp-plugins.transcriptClick");
const clickGlobals = globalThis as typeof globalThis & { [CLICK_KEY]?: Map<string, TranscriptClickHandler> };
const clickHandlers: Map<string, TranscriptClickHandler> = (clickGlobals[CLICK_KEY] ??= new Map());

/**
 * Tool call ids a transcript block draws. Presentable blocks ask `ids.has(id)` for
 * each call they draw before doing anything else; a set that records the question
 * and answers no leaves the block untouched.
 */
function blockToolCallIds(block: object): string[] {
	const refresh = (block as { refreshTranscriptPresentation?: (ids?: ReadonlySet<string>) => boolean })
		.refreshTranscriptPresentation;
	if (typeof refresh !== "function") return [];
	const seen: string[] = [];
	class Probe extends Set<string> {
		override has(id: string): boolean {
			seen.push(id);
			return false;
		}
	}
	refresh.call(block, new Probe());
	return seen;
}

/** Rows of a full card that collapse its expanded group when clicked: its title. */
const COLLAPSE_ROWS = 2;

/** Whether the fullscreen plugin of this package currently draws the transcript. */
function fullscreenActive(): boolean {
	const state = (globalThis as Record<symbol, { handle?: unknown } | undefined>)[
		Symbol.for("sheys-omp-plugins.fullscreen")
	];
	return state?.handle !== undefined;
}

export default function toolgroups(pi: ExtensionAPI): void {
	pi.setLabel("Tool groups");

	const grouper = new Grouper();
	let enabled = process.env.OMP_TOOLGROUPS !== "0";
	let agentRunning = false;
	let warnedSettingOff = false;
	let statsPatched = false;
	void installStatsPatch().then(ok => {
		statsPatched = ok;
	});
	/** The context of the latest main-session event, for the shimmer timer's refreshes. */
	let lastCtx: ExtensionContext | undefined;
	let shimmerTimer: ReturnType<typeof setInterval> | undefined;

	const refresh = (ctx: ExtensionContext, ids: readonly string[]): void => {
		if (ids.length > 0) ctx.ui?.refreshTranscript?.([...new Set(ids)]);
	};

	const allIds = (): string[] => [...grouper.groupOf.keys()];

	/** Rebuild the groups from the active branch (resume, switch, rewind, branch). */
	const rebuild = (ctx: ExtensionContext): void => {
		grouper.reset();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			grouper.beginMessage();
			grouper.feed(entry.message as MessageLike);
		}
		// A resumed session is idle: the last group takes no more calls until text or a user message ends it,
		// but it is not live, so its newest call stays folded.
		refresh(ctx, allIds());
	};

	const isMain = (ctx: ExtensionContext): boolean => {
		if (ctx.agent?.kind === "sub") return false;
		lastCtx = ctx;
		// The main session's binding owns the click handler; subagent bindings never get here.
		clickHandlers.set("toolgroups", onClick);
		return true;
	};

	/** A summary row expands its group; the title row of a card in an expanded group collapses it. */
	function onClick(block: object, row: number): boolean {
		if (!enabled || !lastCtx) return false;
		for (const id of blockToolCallIds(block)) {
			const group = grouper.groupOf.get(id);
			if (!group || group.ids.length < 2) continue;
			const expand = !group.expanded && id === group.ids[0];
			const collapse = group.expanded && row < COLLAPSE_ROWS;
			if (!expand && !collapse) continue;
			group.expanded = expand;
			refresh(lastCtx, group.ids);
			return true;
		}
		return false;
	}

	/** The group drawn live: still taking calls while the agent works, and past one call. */
	const liveGroup = (): Group | undefined => {
		const group = grouper.current;
		return enabled && agentRunning && group && group.ids.length > 1 ? group : undefined;
	};

	const shimmering = (group: Group): boolean =>
		group === liveGroup() && !group.expanded && shimmerEnabled() && fullscreenActive();

	const stopShimmer = (): void => {
		if (shimmerTimer === undefined) return;
		clearInterval(shimmerTimer);
		shimmerTimer = undefined;
	};

	/** Animate the live group's summary; the timer stops itself once nothing shimmers. */
	const syncShimmer = (): void => {
		const group = liveGroup();
		if (!group || !shimmering(group)) {
			stopShimmer();
			return;
		}
		shimmerTimer ??= setInterval(() => {
			const live = liveGroup();
			if (!live || !shimmering(live)) {
				stopShimmer();
				// One last draw settles the row on its static colours.
				if (live && lastCtx) refresh(lastCtx, [live.ids[0]!]);
				return;
			}
			if (lastCtx) refresh(lastCtx, [live.ids[0]!]);
		}, SHIMMER_FRAME_MS);
	};

	pi.registerTranscriptPresenter(block => {
		if (!enabled || block.type !== "toolCall") return undefined;
		const group = grouper.groupOf.get(block.id);
		if (!group) {
			// Not fed yet (the block can be drawn before our message handler runs): a groupable
			// call is either the newest of a live group or a group of one, both one row.
			return isGroupable(block.toolName) ? "compact" : undefined;
		}
		if (group.ids.length === 1) return "compact";
		if (group.expanded) return "full";
		if (block.id === group.ids[0]) {
			const shimmerAt = shimmering(group) ? performance.now() : undefined;
			return { compact: { label: summaryLabel(group, grouper.failed, fullscreenActive(), shimmerAt) } };
		}
		const live = agentRunning && grouper.current === group;
		if (live && block.id === group.ids.at(-1)) return "compact";
		return "hidden";
	});

	pi.on("session_start", (_event, ctx) => {
		if (!isMain(ctx)) return;
		rebuild(ctx);
		if (enabled && !cfgExtensionTranscriptPresenters.get(settings) && !warnedSettingOff) {
			warnedSettingOff = true;
			ctx.ui?.notify?.(
				"Tool groups need extension transcript presenters: run /toolgroups on (or Settings → Tools → Extensions)",
				"info",
			);
		}
	});
	for (const event of ["session_switch", "session_branch", "session_tree", "session_clear", "session_compact"] as const) {
		pi.on(event, (_event, ctx) => {
			if (isMain(ctx)) rebuild(ctx);
		});
	}

	pi.on("agent_start", (_event, ctx) => {
		if (!isMain(ctx)) return;
		agentRunning = true;
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!isMain(ctx)) return;
		agentRunning = false;
		stopShimmer();
		// The live group's newest call folds into the summary, which stops shimmering.
		const group = grouper.current;
		if (group) refresh(ctx, [group.ids[0]!, group.ids.at(-1)!]);
	});

	pi.on("message_start", (_event, ctx) => {
		if (isMain(ctx)) grouper.beginMessage();
	});
	pi.on("message_update", (event, ctx) => {
		if (!isMain(ctx)) return;
		const message = event.message as MessageLike;
		if (message.role !== "assistant") return;
		refresh(ctx, grouper.feed(message));
		syncShimmer();
	});
	pi.on("message_end", (event, ctx) => {
		if (!isMain(ctx)) return;
		refresh(ctx, grouper.feed(event.message as MessageLike));
		syncShimmer();
	});

	pi.registerCommand("toolgroups", {
		description: "Collapse runs of tool calls into one summary row (on|off|stats)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "stats" || arg.startsWith("stats ")) {
				if (!statsPatched) {
					ctx.ui.notify("Usage-row hiding is unavailable on this omp version", "warning");
					return;
				}
				const value = arg.slice(5).trim();
				stats.hide = value === "all" ? false : value === "final" ? true : !stats.hide;
				ctx.ui.notify(
					stats.hide ? "Usage rows: final answer of each turn only" : "Usage rows: every request",
					"info",
				);
				return;
			}
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			if (enabled && !cfgExtensionTranscriptPresenters.get(settings)) {
				// Turning the setting on redraws every block with the presenters.
				cfgExtensionTranscriptPresenters.set(settings, true);
				ctx.ui.notify("Tool groups on (enabled extension transcript presenters)", "info");
				return;
			}
			if (!enabled) stopShimmer();
			refresh(ctx, allIds());
			ctx.ui.notify(`Tool groups ${enabled ? "on" : "off"}`, "info");
		},
	});
}
