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
 *   under them. The dock's leading blank rows and right-hand chips (the
 *   throughput readout) float: the transcript shows through them, and the
 *   "jump to latest" button floats over it too.
 * - Mouse reporting is on (wheel, clicks), which takes the terminal's own text
 *   selection away, so the view selects itself: a drag highlights transcript
 *   cells anchored to content rows and copies the plain text on release.
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
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import {
	type Component,
	CURSOR_MARKER,
	matchesKey,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	parseSgrMouse,
	type SgrMouseEvent,
	sliceByColumn,
	TUI,
	theme,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { compositeLineAt } from "@oh-my-pi/pi-tui/render/composite";

type OverlayEntry = TUI["overlayStack"][number];
type InputResult = { consume?: boolean; data?: string } | undefined;

/** Rows one mouse-wheel notch scrolls. */
const WHEEL_ROWS = 3;
/** How long the "Copied" pill stays up. */
const FLASH_MS = 1500;
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

/** Right-hand content of a floating dock row, in screen columns `[start, end)`. */
interface FloatingChip {
	readonly row: string;
	readonly start: number;
	readonly end: number;
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

/** A content row: row `row` of segment `key`, `fromEnd` rows above the end of the content (1 = last row). */
interface RowRef {
	readonly key: object;
	readonly row: number;
	readonly fromEnd: number;
}

/** A selection endpoint, anchored to content so it survives scrolling and output below it. */
interface ContentPoint {
	readonly key: object;
	readonly row: number;
	readonly col: number;
}

interface SegmentSource {
	readonly transcript: TranscriptContainer | undefined;
	readonly above: readonly Component[];
	readonly width: number;
}

/** Selection bounds in content order; `start` is the earlier (higher) end. */
interface SelectionRange {
	readonly startFromEnd: number;
	readonly startCol: number;
	readonly endFromEnd: number;
	readonly endCol: number;
}

/** Order two endpoints against `segments`; an endpoint whose segment was not pulled lies above them all. */
function selectionRange(segments: readonly Segment[], a: ContentPoint, b: ContentPoint): SelectionRange {
	const position = (point: ContentPoint): number => {
		const segment = segments.find(candidate => candidate.key === point.key);
		return segment === undefined ? Number.POSITIVE_INFINITY : segment.below + segment.rows.length - point.row;
	};
	const fa = position(a);
	const fb = position(b);
	const aFirst = fa > fb || (fa === fb && a.col <= b.col);
	const [start, end, startFromEnd, endFromEnd] = aFirst ? [a, b, fa, fb] : [b, a, fb, fa];
	return { startFromEnd, startCol: start.col, endFromEnd, endCol: end.col };
}

/**
 * Selected columns `[from, to)` of a content row, up to its last visible
 * character (`from >= to`: an empty row inside the selection); `undefined`
 * outside the selection.
 */
function selectedColumns(range: SelectionRange, fromEnd: number, line: string): [number, number] | undefined {
	if (fromEnd > range.startFromEnd || fromEnd < range.endFromEnd) return undefined;
	const from = fromEnd === range.startFromEnd ? range.startCol : 0;
	const textEnd = visibleWidth(Bun.stripANSI(line).trimEnd());
	// The end cell is the one under the pointer, so it is included.
	const to = Math.min(textEnd, fromEnd === range.endFromEnd ? range.endCol + 1 : textEnd);
	return [from, to];
}

/** A dock cell, counted from the bottom of the screen (1 = last row): the dock is pinned there. */
interface DockPoint {
	readonly fromBottom: number;
	readonly col: number;
}

/** Order two dock endpoints; rows count from the bottom like content rows count from the end. */
function dockRange(a: DockPoint, b: DockPoint): SelectionRange {
	const aFirst = a.fromBottom > b.fromBottom || (a.fromBottom === b.fromBottom && a.col <= b.col);
	const [start, end] = aFirst ? [a, b] : [b, a];
	return { startFromEnd: start.fromBottom, startCol: start.col, endFromEnd: end.fromBottom, endCol: end.col };
}

/**
 * Box-drawing glyphs (the editor frame) at either end of a selected dock row. The
 * left frame is `│` on some rows and `╰─` on others, so it turns into blanks of the
 * same width and the shared margin goes with the rest of the indentation.
 */
const BOX_EDGE_START = /^[\u2500-\u257F]+/;
const BOX_EDGE_END = /[\s\u2500-\u257F]+$/;

/** Plain text of cells `[from, to)`; the editor's cursor marker is not text. */
function plainCells(line: string, from: number, to: number): string {
	return Bun.stripANSI(sliceByColumn(line, from, to - from, true).replaceAll(CURSOR_MARKER, ""));
}

/**
 * Inverse-video cells `[from, to)` of `line`. A cursor marker inside them is
 * kept in place, so the editor's hardware cursor stays where it was.
 */
function invertCells(line: string, [from, to]: [number, number], width: number): string {
	if (from >= to) return line;
	const marker = line.indexOf(CURSOR_MARKER);
	const markerCol = marker < 0 ? -1 : visibleWidth(line.slice(0, marker));
	const text = plainCells(line, from, to);
	const painted =
		markerCol >= from && markerCol <= to
			? theme.inverse(sliceByColumn(text, 0, markerCol - from)) +
				CURSOR_MARKER +
				theme.inverse(sliceByColumn(text, markerCol - from, to - markerCol))
			: theme.inverse(text);
	return compositeLineAt(line, painted, from, to - from, width);
}

/** Selected rows as text: the common left margin of rows selected from column 0 is dropped. */
function joinSelectedLines(lines: readonly { text: string; fromLeft: boolean }[]): string {
	let indent = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		if (line.fromLeft && line.text.trim() !== "") {
			indent = Math.min(indent, line.text.length - line.text.trimStart().length);
		}
	}
	if (!Number.isFinite(indent)) indent = 0;
	return lines
		.map(line => (line.fromLeft ? line.text.slice(indent) : line.text))
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}

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
	/** Content row behind each transcript-area screen row of the last frame; `undefined` below short content. */
	#rowMap: (RowRef | undefined)[] = [];
	/** Segments the last frame pulled, bottom-up. */
	#lastSegments: readonly Segment[] = [];
	/** What the last frame laid out, so a copy can walk past the window. */
	#source: SegmentSource | undefined;
	#selection: { anchor: ContentPoint; head: ContentPoint; dragging: boolean } | undefined;
	/** Selection over the dock (the editor's draft, status line); at most one of the two is set. */
	#dockSelection: { anchor: DockPoint; head: DockPoint; dragging: boolean } | undefined;
	/** Solid dock rows of the last frame, below the transcript area. */
	#lastDock: readonly string[] = [];
	#flash: { text: string; until: number } | undefined;

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
		// The dock's leading rows that are blank or carry only a right-hand chip (the throughput
		// readout) float: the transcript runs on behind them and shows through their empty cells.
		const chips: (FloatingChip | undefined)[] = [];
		for (const row of dock) {
			const text = Bun.stripANSI(row);
			const start = text.length - text.trimStart().length;
			if (start === text.length) {
				chips.push(undefined);
				continue;
			}
			if (start < width / 2) break;
			chips.push({ row, start, end: visibleWidth(row) - (text.length - text.trimEnd().length) });
		}
		const area = height - dock.length + chips.length;

		const now = performance.now();
		const segments = this.#segments(transcript, above, width, { now, tick: Math.floor(now / 80) });
		this.#source = { transcript, above, width };
		const window = this.#layoutWindow(segments, area);
		while (window.length < area) window.push("");
		this.#paintSelection(window, width);
		const band = area - chips.length;
		for (let index = 0; index < chips.length; index++) {
			const chip = chips[index];
			if (!chip) continue;
			// One empty cell keeps the chip off the transcript text it covers.
			const chipText = ` ${sliceByColumn(chip.row, chip.start, chip.end - chip.start, true)}`;
			window[band + index] = compositeLineAt(window[band + index]!, chipText, chip.start - 1, chip.end - chip.start + 1, width);
		}
		// The button floats on the row above the first chip, or on the last floating row.
		const firstChip = chips.findIndex(chip => chip !== undefined);
		const hintRow = firstChip < 0 ? area - 1 : band + firstChip - 1;
		this.#hint = undefined;
		if (this.#lastOffset > 0 && hintRow >= 0) window[hintRow] = this.#scrollHint(window[hintRow]!, width, hintRow);
		const flash = this.#flash;
		if (flash !== undefined && Date.now() < flash.until && window.length > 0) {
			const pill = truncateToWidth(` ${flash.text} `, Math.max(0, width - 2));
			const pillWidth = visibleWidth(pill);
			const start = Math.max(0, width - pillWidth - 1);
			window[0] = compositeLineAt(window[0]!, theme.bg("selectedBg", theme.fg("accent", pill)), start, pillWidth, width);
		}
		const solid = dock.slice(chips.length);
		this.#lastDock = solid.slice();
		this.#paintDockSelection(solid, width);
		return [...window, ...solid];
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
		const rowMap: RowRef[] = [];
		for (let index = segments.length - 1; index >= 0; index--) {
			const segment = segments[index]!;
			const segmentTop = segment.below + segment.rows.length;
			if (segmentTop <= offset || segment.below >= top) continue;
			const first = Math.max(0, segmentTop - top);
			const last = Math.min(segment.rows.length, segmentTop - offset);
			for (let row = first; row < last; row++) {
				window.push(segment.rows[row]!);
				rowMap.push({ key: segment.key, row, fromEnd: segmentTop - row });
			}
		}
		this.#rowMap = rowMap;
		this.#lastSegments = segments;
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

	/** Invert the selected cells of the window's content rows. */
	#paintSelection(window: string[], width: number): void {
		const selection = this.#selection;
		if (selection === undefined) return;
		const range = selectionRange(this.#lastSegments, selection.anchor, selection.head);
		for (let index = 0; index < this.#rowMap.length; index++) {
			const line = window[index]!;
			const columns = selectedColumns(range, this.#rowMap[index]!.fromEnd, line);
			if (columns !== undefined) window[index] = invertCells(line, columns, width);
		}
	}

	/** Invert the selected cells of the dock's rows (editor, status line, widgets). */
	#paintDockSelection(dock: string[], width: number): void {
		const selection = this.#dockSelection;
		if (selection === undefined) return;
		const range = dockRange(selection.anchor, selection.head);
		for (let index = 0; index < dock.length; index++) {
			const columns = selectedColumns(range, dock.length - index, dock[index]!);
			if (columns !== undefined) dock[index] = invertCells(dock[index]!, columns, width);
		}
	}

	/** The dock cell under a screen cell; above the dock it clamps to the start of its top row. */
	#dockPointAt(row: number, col: number): DockPoint | undefined {
		const rows = this.#lastDock.length;
		if (rows === 0) return undefined;
		const fromBottom = this.#lastArea + rows - row;
		return fromBottom > rows ? { fromBottom: rows, col: 0 } : { fromBottom: Math.max(1, fromBottom), col: Math.max(0, col) };
	}

	/** Dock drags select screen cells; the dock does not scroll, so cells are its content. */
	#handleDockSelectionMouse(event: SgrMouseEvent): void {
		const selection = this.#dockSelection;
		if (selection === undefined || !selection.dragging) return;
		const dragged = event.motion && (event.button & 3) === 0;
		if (!dragged && !event.release) return;
		const head = this.#dockPointAt(event.row, event.col) ?? selection.head;
		this.#dockSelection = { anchor: selection.anchor, head, dragging: !event.release };
		if (event.release) {
			const { anchor } = selection;
			if (anchor.fromBottom === head.fromBottom && anchor.col === head.col) this.#dockSelection = undefined;
			else this.#copyText(this.#dockText(dockRange(anchor, head)));
		}
		this.ui.requestRender();
	}

	/** Plain text of the selected dock cells, without the editor box's border glyphs. */
	#dockText(range: SelectionRange): string {
		const dock = this.#lastDock;
		const lines: { text: string; fromLeft: boolean }[] = [];
		for (let index = 0; index < dock.length; index++) {
			const line = dock[index]!;
			const columns = selectedColumns(range, dock.length - index, line);
			if (columns === undefined) continue;
			const [from, to] = columns;
			let text = from < to ? plainCells(line, from, to).replace(BOX_EDGE_END, "") : "";
			text = text.replace(BOX_EDGE_START, edge => " ".repeat(edge.length));
			lines.push({ text: from === 0 ? text : text.trimStart(), fromLeft: from === 0 });
		}
		return joinSelectedLines(lines);
	}

	/**
	 * Content under a transcript-area cell. Below short content, or over the
	 * dock while dragging, it clamps to the end of the last content row.
	 */
	#pointAt(row: number, col: number): ContentPoint | undefined {
		const map = this.#rowMap;
		if (map.length === 0) return undefined;
		const index = Math.max(0, Math.min(row, map.length - 1));
		const ref = map[index]!;
		return { key: ref.key, row: ref.row, col: row > index ? Number.MAX_SAFE_INTEGER : Math.max(0, col) };
	}

	/** Press starts a selection, a drag extends it (scrolling at the edges), release copies it. */
	#handleSelectionMouse(event: SgrMouseEvent): void {
		if (event.leftClick) {
			const inDock = event.row >= this.#lastArea;
			const point = inDock ? undefined : this.#pointAt(event.row, event.col);
			const dockPoint = inDock ? this.#dockPointAt(event.row, event.col) : undefined;
			this.#selection = point === undefined ? undefined : { anchor: point, head: point, dragging: true };
			this.#dockSelection =
				dockPoint === undefined ? undefined : { anchor: dockPoint, head: dockPoint, dragging: true };
			this.ui.requestRender();
			return;
		}
		if (this.#dockSelection !== undefined) {
			this.#handleDockSelectionMouse(event);
			return;
		}
		const selection = this.#selection;
		if (selection === undefined || !selection.dragging) return;
		const dragged = event.motion && (event.button & 3) === 0;
		if (!dragged && !event.release) return;
		if (dragged && event.row <= 0) this.scrollBy(1);
		else if (dragged && event.row >= this.#lastArea - 1) this.scrollBy(-1);
		const head = this.#pointAt(event.row, event.col) ?? selection.head;
		this.#selection = { anchor: selection.anchor, head, dragging: !event.release };
		if (event.release) this.#copySelection();
		this.ui.requestRender();
	}

	#copySelection(): void {
		const selection = this.#selection;
		if (selection === undefined) return;
		const { anchor, head } = selection;
		if (anchor.key === head.key && anchor.row === head.row && anchor.col === head.col) {
			// A plain click clears rather than selecting one cell.
			this.#selection = undefined;
			return;
		}
		this.#copyText(this.#selectedText(anchor, head));
	}

	#copyText(text: string): void {
		if (text === "") return;
		const lines = text.split("\n").length;
		copyToClipboard(text).then(
			() => this.#showFlash(`Copied ${lines} line${lines === 1 ? "" : "s"}`),
			() => this.#showFlash("Copy failed"),
		);
	}

	#showFlash(text: string): void {
		this.#flash = { text, until: Date.now() + FLASH_MS };
		this.ui.requestRender();
		setTimeout(() => this.ui.requestRender(), FLASH_MS + 50);
	}

	/** Plain text of the selection, read past the window when the drag scrolled. */
	#selectedText(anchor: ContentPoint, head: ContentPoint): string {
		const source = this.#source;
		if (source === undefined) return "";
		const now = performance.now();
		const segments: Segment[] = [];
		const missing = new Set<object>([anchor.key, head.key]);
		let total = 0;
		for (const next of this.#segments(source.transcript, source.above, source.width, {
			now,
			tick: Math.floor(now / 80),
		})) {
			segments.push({ ...next, below: total });
			total += next.rows.length;
			missing.delete(next.key);
			if (missing.size === 0) break;
		}
		// An endpoint's block is gone (rewind, cleared session).
		if (missing.size > 0) return "";
		const range = selectionRange(segments, anchor, head);
		const lines: { text: string; fromLeft: boolean }[] = [];
		for (let index = segments.length - 1; index >= 0; index--) {
			const segment = segments[index]!;
			const segmentTop = segment.below + segment.rows.length;
			for (let row = 0; row < segment.rows.length; row++) {
				const line = segment.rows[row]!;
				const columns = selectedColumns(range, segmentTop - row, line);
				if (columns === undefined) continue;
				const [from, to] = columns;
				const text = from < to ? plainCells(line, from, to).trimEnd() : "";
				lines.push({ text, fromLeft: from === 0 });
			}
		}
		return joinSelectedLines(lines);
	}

	#scrollHint(base: string, width: number, row: number): string {
		const rows = this.#lastOffset;
		const label = ` ↓ ${rows} more line${rows === 1 ? "" : "s"} · click or Ctrl+End to jump to latest `;
		const text = truncateToWidth(label, Math.max(0, width - 2));
		const textWidth = visibleWidth(text);
		const start = Math.max(1, Math.floor((width - textWidth) / 2));
		this.#hint = { row, start, end: start + textWidth };
		// A blank cell on each side separates the button from the transcript behind it.
		const button = ` ${theme.bg("selectedBg", theme.fg("accent", text))} `;
		return compositeLineAt(base, button, start - 1, Math.min(textWidth + 2, width - start + 1), width);
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

	/** TUI-wide input listener: wheel, clicks and drags over the transcript, and paging keys. */
	handleTuiInput(data: string): InputResult {
		const top = this.ui.overlayStack.findLast(entry => isEntryVisible(this.ui, entry));
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (!event) return undefined;
			// Pickers and viewers that asked for the screen route their own pointer input.
			if (top !== undefined && top.component !== this) return undefined;
			if (event.wheel !== null) {
				this.scrollBy(-event.wheel * WHEEL_ROWS);
				return { consume: true };
			}
			const hint = this.#hint;
			if (
				event.leftClick &&
				hint !== undefined &&
				event.row === hint.row &&
				event.col >= hint.start &&
				event.col < hint.end
			) {
				this.#selection = undefined;
				this.#dockSelection = undefined;
				this.scrollToBottom();
				return { consume: true };
			}
			this.#handleSelectionMouse(event);
			return { consume: true };
		}
		// Typing dismisses a finished selection.
		if (
			(this.#selection !== undefined && !this.#selection.dragging) ||
			(this.#dockSelection !== undefined && !this.#dockSelection.dragging)
		) {
			this.#selection = undefined;
			this.#dockSelection = undefined;
			this.ui.requestRender();
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
