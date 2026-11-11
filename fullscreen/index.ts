/**
 * Fullscreen mode for oh-my-pi: the transcript scrolls inside the terminal's
 * alternate screen while the editor, status line and every widget around the
 * editor stay pinned to the bottom (the Claude Code / Pi "sticky footer").
 *
 * omp has no fullscreen renderer, so this plugin works on pi-tui internals at
 * runtime. They are host modules shared with the running binary, so the
 * classes imported here are the live ones:
 *
 * - The whole UI is drawn by one fullscreen overlay at the bottom of the overlay
 *   stack. The TUI's own alt-screen path then handles buffer switching, mouse
 *   reporting, row diffing, images and resizes. The overlay renders the
 *   transcript's blocks bottom-up and the roots after it (the "dock": pending
 *   messages, todos, working row, editor, hook widgets, status line) pinned
 *   under them.
 * - The overlay never holds keys (`released` is pinned), so focus and input stay
 *   with the editor. It does own the dock's focus targets, so the TUI parks the
 *   hardware cursor on the editor. `hasOverlay()` ignores it, so global
 *   shortcuts keep working.
 * - Overlays that omp opens over the transcript (popups, dialogs) are promoted
 *   to fullscreen while the mode is on, so they composite over this view
 *   instead of switching back to the normal buffer.
 * - While the alt screen is up, omp's normal-screen frame provider is paused,
 *   as it is under any fullscreen overlay. Finished blocks reach the shell's
 *   scrollback when the mode is turned off or omp exits.
 *
 * Built against omp 18.18.x; internals it relies on may move in other releases.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	parseSgrMouse,
	TUI,
	theme,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";

type OverlayEntry = TUI["overlayStack"][number];
type InputResult = { consume?: boolean; data?: string } | undefined;

/** Rows one mouse-wheel notch scrolls. */
const WHEEL_ROWS = 3;
/** Allocation transcript blocks get when laid out in full (what `TranscriptContainer.render` uses). */
const FULL_ALLOCATION = Number.MAX_SAFE_INTEGER;
const OVERLAY_OPTIONS: OverlayOptions = {
	fullscreen: true,
	mouseTracking: true,
	width: "100%",
	maxHeight: "100%",
	anchor: "top-left",
	margin: 0,
};

/** Optional transcript-block hooks (`TranscriptPresentationTarget`, `CompactTranscriptBlock`). */
interface TranscriptBlockHooks {
	setTranscriptAllocation?(rows: number, frame: { now: number; tick: number }): void;
	isTranscriptBlockCompact?(): boolean;
}

interface Segment {
	/** Stable identity of the rows (a block, a root, or a separator owned by a block) for scroll anchoring. */
	readonly key: object;
	readonly rows: readonly string[];
	/** Content rows below this segment. */
	readonly below: number;
}

type ScrollState =
	| { readonly kind: "follow" }
	| { readonly kind: "offset"; readonly offset: number }
	/** Top visible row is `row` of segment `key`: content growing below keeps the view still. */
	| { readonly kind: "anchor"; readonly key: object; readonly row: number };

const FOLLOW: ScrollState = { kind: "follow" };

interface FullscreenState {
	patched: boolean;
	/** Mode requested for this process (`/fullscreen`, `OMP_FULLSCREEN`). */
	enabled: boolean;
	composer: Composer | undefined;
	view: FullscreenView | undefined;
	handle: OverlayHandle | undefined;
	removeInputListener: (() => void) | undefined;
	activationQueued: boolean;
	/** Overlays that asked for fullscreen themselves (pickers, viewers); everything else is a promoted popup. */
	readonly ownFullscreen: WeakSet<Component>;
}

// Shared across module re-evaluations (extension reloads) so the prototypes are patched once.
const STATE_KEY = Symbol.for("sheys-omp-plugins.fullscreen");
const globals = globalThis as typeof globalThis & { [STATE_KEY]?: FullscreenState };
const state: FullscreenState = (globals[STATE_KEY] ??= {
	patched: false,
	enabled: process.env.OMP_FULLSCREEN !== "0",
	composer: undefined,
	view: undefined,
	handle: undefined,
	removeInputListener: undefined,
	activationQueued: false,
	ownFullscreen: new WeakSet(),
});

function isEntryVisible(ui: TUI, entry: OverlayEntry): boolean {
	if (entry.hidden) return false;
	return entry.options?.visible?.(ui.terminal.columns, ui.terminal.rows) ?? true;
}

/** Options whose `fullscreen` follows the mode, so a popup stays on the alt screen with this view under it. */
function promoteWhileActive(ui: TUI, options: OverlayOptions | undefined): OverlayOptions {
	const promoted: OverlayOptions = { ...options };
	Object.defineProperty(promoted, "fullscreen", {
		get: () => state.handle !== undefined && state.view?.ui === ui,
		enumerable: true,
		configurable: true,
	});
	return promoted;
}

class FullscreenView implements Component, OverlayFocusOwner {
	readonly ui: TUI;
	readonly #composer: Composer;
	#scroll: ScrollState = FOLLOW;
	/** Rows below the viewport in the last frame; 0 while following the bottom. */
	#lastOffset = 0;
	/** Transcript rows shown in the last frame. */
	#lastArea = 0;
	/** Screen cells of the "jump to latest" hint in the last frame; the view is painted from row 0. */
	#hint: { readonly row: number; readonly start: number; readonly end: number } | undefined;
	readonly #separatorKeys = new WeakMap<Component, object>();

	constructor(composer: Composer) {
		this.#composer = composer;
		this.ui = composer.ui;
	}

	/**
	 * The editor and inline selectors in the dock belong to this page: the TUI
	 * only places the hardware cursor for a focus target the top fullscreen
	 * overlay owns. Targets of other overlays stay theirs.
	 */
	ownsOverlayFocusTarget(component: Component): boolean {
		return !this.ui.overlayStack.some(
			entry =>
				entry.component !== this &&
				(entry.component === component ||
					(entry.component as Component & Partial<OverlayFocusOwner>).ownsOverlayFocusTarget?.(component) === true),
		);
	}

	/**
	 * The TUI focuses an overlay when it is shown or when a covering overlay is
	 * hidden by a resize; give the keys straight back to the editor.
	 */
	get focused(): boolean {
		return false;
	}
	set focused(value: boolean) {
		if (!value) return;
		queueMicrotask(() => {
			if (this.ui.getFocused() === this) this.ui.setFocus(this.#composer.editor);
		});
	}

	render(width: number): readonly string[] {
		const height = Math.max(0, this.ui.terminal.rows);
		if (this.#coveredByFullscreenOverlay()) return Array.from({ length: height }, () => "");

		const roots = this.ui.children;
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		const transcript = transcriptIndex < 0 ? undefined : (roots[transcriptIndex] as TranscriptContainer);
		// Before the session mounts (startup) the roots are header, gap, editor, status: only the header scrolls.
		const aboveEnd = transcript ? transcriptIndex : Math.min(1, roots.length);
		const above = roots.slice(0, aboveEnd);
		const below = roots.slice(transcript ? aboveEnd + 1 : aboveEnd);

		let dock: string[] = [];
		for (const root of below) dock.push(...root.render(width));
		if (dock.length > height) dock = dock.slice(dock.length - height);
		const area = height - dock.length;

		const now = performance.now();
		const segments = this.#segments(transcript, above, width, { now, tick: Math.floor(now / 80) });
		const window = this.#layoutWindow(segments, area);
		this.#hint = undefined;
		if (this.#lastOffset > 0 && window.length > 0) window[window.length - 1] = this.#scrollHint(width, window.length - 1);
		while (window.length < area) window.push("");
		return [...window, ...dock];
	}

	/** Another overlay that asked for the whole screen is on top: leave it a blank base. */
	#coveredByFullscreenOverlay(): boolean {
		const stack = this.ui.overlayStack;
		const at = stack.findIndex(entry => entry.component === this);
		for (let index = at + 1; index < stack.length; index++) {
			const entry = stack[index]!;
			if (state.ownFullscreen.has(entry.component) && isEntryVisible(this.ui, entry)) return true;
		}
		return false;
	}

	/**
	 * Content segments bottom-up: transcript blocks with the blank separators
	 * `TranscriptContainer` puts between them, then the roots above the
	 * transcript (the welcome header). Lazy, so a frame only renders the blocks
	 * it shows; block renders are memoized by the blocks themselves.
	 */
	*#segments(
		transcript: TranscriptContainer | undefined,
		above: readonly Component[],
		width: number,
		frame: { now: number; tick: number },
	): Generator<Omit<Segment, "below">> {
		let compactBelow: boolean | undefined;
		const blocks = transcript?.children ?? [];
		for (let index = blocks.length - 1; index >= 0; index--) {
			const block = blocks[index]! as Component & TranscriptBlockHooks;
			block.setTranscriptAllocation?.(FULL_ALLOCATION, frame);
			const rows = trimBlankEdges(block.render(width));
			if (rows.length === 0) continue;
			const compact = block.isTranscriptBlockCompact?.() === true;
			if (compactBelow !== undefined && !(compact && compactBelow)) {
				yield { key: this.#separatorKey(block), rows: [""] };
			}
			yield { key: block, rows };
			compactBelow = compact;
		}
		for (let index = above.length - 1; index >= 0; index--) {
			const root = above[index]!;
			const rows = trimBlankEdges(root.render(width));
			if (rows.length === 0) continue;
			if (compactBelow !== undefined) yield { key: this.#separatorKey(root), rows: [""] };
			yield { key: root, rows };
			compactBelow = false;
		}
	}

	#separatorKey(owner: Component): object {
		let key = this.#separatorKeys.get(owner);
		if (!key) {
			key = {};
			this.#separatorKeys.set(owner, key);
		}
		return key;
	}

	/** Pick the visible slice of the content for this frame and re-anchor the scroll position. */
	#layoutWindow(source: Iterator<Omit<Segment, "below">>, area: number): string[] {
		const segments: Segment[] = [];
		let total = 0;
		let exhausted = false;
		const pull = (): Segment | undefined => {
			const next = source.next();
			if (next.done) {
				exhausted = true;
				return undefined;
			}
			const segment = { ...next.value, below: total };
			segments.push(segment);
			total += segment.rows.length;
			return segment;
		};

		const scroll = this.#scroll;
		let offset = 0;
		if (scroll.kind === "offset") {
			offset = scroll.offset;
		} else if (scroll.kind === "anchor") {
			let found: Segment | undefined;
			while (!found) {
				const segment = pull();
				if (!segment) break;
				if (segment.key === scroll.key) found = segment;
			}
			// A vanished anchor (rewind, cleared session) falls back to the bottom.
			if (found) offset = found.below + found.rows.length - Math.min(scroll.row, found.rows.length - 1) - area;
		}
		while (!exhausted && total < offset + area) pull();
		if (exhausted) offset = Math.min(offset, total - area);
		offset = Math.max(0, offset);

		this.#lastOffset = offset;
		this.#lastArea = area;
		this.#scroll = offset === 0 ? FOLLOW : this.#anchorAt(segments, offset + area);

		// Rows numbered from the end: the window shows (offset, offset + area].
		const top = Math.min(total, offset + area);
		const window: string[] = [];
		for (let index = segments.length - 1; index >= 0; index--) {
			const segment = segments[index]!;
			const segmentTop = segment.below + segment.rows.length;
			if (segmentTop <= offset || segment.below >= top) continue;
			const first = Math.max(0, segmentTop - top);
			const last = Math.min(segment.rows.length, segmentTop - offset);
			for (let row = first; row < last; row++) window.push(segment.rows[row]!);
		}
		return window;
	}

	/** Anchor for the row `fromEnd` rows above the end of the content (1 = last row). */
	#anchorAt(segments: readonly Segment[], fromEnd: number): ScrollState {
		for (const segment of segments) {
			const segmentTop = segment.below + segment.rows.length;
			if (fromEnd > segment.below && fromEnd <= segmentTop) {
				return { kind: "anchor", key: segment.key, row: segmentTop - fromEnd };
			}
		}
		return { kind: "offset", offset: this.#lastOffset };
	}

	#scrollHint(width: number, row: number): string {
		const rows = this.#lastOffset;
		const label = ` ↓ ${rows} more line${rows === 1 ? "" : "s"} · click or Ctrl+End to jump to latest `;
		const text = truncateToWidth(label, width);
		const textWidth = visibleWidth(text);
		const pad = Math.max(0, Math.floor((width - textWidth) / 2));
		this.#hint = { row, start: pad, end: pad + textWidth };
		return " ".repeat(pad) + theme.bg("selectedBg", theme.fg("accent", text));
	}

	/** `delta` rows toward older content (negative: toward the latest). */
	scrollBy(delta: number): void {
		const base = this.#scroll.kind === "offset" ? this.#scroll.offset : this.#lastOffset;
		const offset = Math.max(0, base + delta);
		this.#scroll = offset === 0 ? FOLLOW : { kind: "offset", offset };
		this.ui.requestRender();
	}

	scrollToBottom(): void {
		this.#scroll = FOLLOW;
		this.ui.requestRender();
	}

	scrollToTop(): void {
		this.#scroll = { kind: "offset", offset: Number.MAX_SAFE_INTEGER };
		this.ui.requestRender();
	}

	/** TUI-wide input listener: wheel and paging keys scroll the transcript. */
	handleTuiInput(data: string): InputResult {
		const top = this.ui.overlayStack.findLast(entry => isEntryVisible(this.ui, entry));
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (!event) return undefined;
			// Pickers and viewers that asked for the screen route their own pointer input.
			if (top !== undefined && top.component !== this) return undefined;
			if (event.wheel !== null) this.scrollBy(-event.wheel * WHEEL_ROWS);
			const hint = this.#hint;
			if (
				event.leftClick &&
				hint !== undefined &&
				event.row === hint.row &&
				event.col >= hint.start &&
				event.col < hint.end
			) {
				this.scrollToBottom();
			}
			return { consume: true };
		}
		if (top?.component !== this || this.ui.getFocused() !== this.#composer.editor) return undefined;
		const page = Math.max(1, this.#lastArea - 2);
		if (matchesKey(data, "pageUp")) {
			this.scrollBy(page);
			return { consume: true };
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollBy(-page);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+end")) {
			this.scrollToBottom();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+home")) {
			this.scrollToTop();
			return { consume: true };
		}
		// Submitting from a scrolled-back view follows the new turn.
		if (matchesKey(data, "enter") && this.#lastOffset > 0) this.scrollToBottom();
		return undefined;
	}
}

function activate(): void {
	const composer = state.composer;
	if (!state.enabled || state.handle !== undefined || composer === undefined) return;
	const ui = composer.ui;
	if (state.view?.ui !== ui) state.view = new FullscreenView(composer);
	const view = state.view;
	const focus = ui.getFocused();
	state.handle = ui.showOverlay(view, OVERLAY_OPTIONS);
	const stack = ui.overlayStack;
	const at = stack.findIndex(entry => entry.component === view);
	const entry = stack[at];
	if (entry) {
		// Bottom of the stack: everything omp opens draws over the transcript.
		stack.splice(at, 1);
		stack.unshift(entry);
		// Pinned: focusing a target this view owns would otherwise make it hold the keys again.
		Object.defineProperty(entry, "released", { get: () => true, set: () => {}, configurable: true });
	}
	ui.setFocus(focus);
	state.removeInputListener = ui.addInputListener(data => view.handleTuiInput(data), { prepend: true });
	ui.requestRender();
}

function deactivate(): void {
	const view = state.view;
	const handle = state.handle;
	if (view === undefined || handle === undefined) return;
	const ui = view.ui;
	const focus = ui.getFocused();
	state.removeInputListener?.();
	state.removeInputListener = undefined;
	state.handle = undefined;
	handle.hide();
	if (focus !== null && focus !== view) ui.setFocus(focus);
	ui.requestRender();
}

function queueActivation(): void {
	if (state.activationQueued) return;
	state.activationQueued = true;
	// Never mutate the overlay stack from inside the frame that is being composed.
	queueMicrotask(() => {
		state.activationQueued = false;
		activate();
	});
}

function installPatches(): void {
	if (state.patched) return;
	state.patched = true;

	// The interactive composer is the normal-screen frame provider; its first frame identifies the live TUI.
	const renderFrame = Composer.prototype.renderFrame;
	Composer.prototype.renderFrame = function (this: Composer, viewport) {
		if (state.composer !== this) state.composer = this;
		if (state.enabled && state.handle === undefined) queueActivation();
		return renderFrame.call(this, viewport);
	};

	const showOverlay = TUI.prototype.showOverlay;
	TUI.prototype.showOverlay = function (this: TUI, component: Component, options?: OverlayOptions) {
		if (component === state.view) return showOverlay.call(this, component, options);
		if (options?.fullscreen === true) {
			state.ownFullscreen.add(component);
			return showOverlay.call(this, component, options);
		}
		return showOverlay.call(this, component, promoteWhileActive(this, options));
	};

	// Callers use `hasOverlay()` to mean "a dialog is open"; the fullscreen view is not one.
	const hasOverlay = TUI.prototype.hasOverlay;
	TUI.prototype.hasOverlay = function (this: TUI) {
		const view = state.view;
		if (view === undefined || state.handle === undefined || view.ui !== this) return hasOverlay.call(this);
		return this.overlayStack.some(entry => entry.component !== view && isEntryVisible(this, entry));
	};
}

export default function fullscreen(pi: ExtensionAPI): void {
	pi.setLabel("Fullscreen");
	installPatches();

	pi.registerCommand("fullscreen", {
		description: "Toggle fullscreen mode: pinned editor and footer, scrollable transcript (on|off)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const enabled = arg === "on" ? true : arg === "off" ? false : !state.enabled;
			state.enabled = enabled;
			if (enabled) activate();
			else deactivate();
			if (enabled && state.composer === undefined) {
				ctx.ui.notify("Fullscreen needs the interactive terminal UI", "warning");
				return;
			}
			ctx.ui.notify(`Fullscreen ${enabled ? "on" : "off"}`, "info");
		},
	});
}
