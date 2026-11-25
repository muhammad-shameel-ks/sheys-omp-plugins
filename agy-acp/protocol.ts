/**
 * Core Agent Client Protocol (ACP v1) types, NDJSON stdio framing, session state
 * normalization, turn update accumulation, and client-side `fs/*` + `terminal/*`
 * capability handlers matching T3 Code's thin-client ACP host architecture.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly result?: unknown;
	readonly error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface AuthMethod {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
}

export interface InitializeResult {
	readonly protocolVersion: number;
	readonly agentCapabilities?: {
		readonly loadSession?: boolean;
		readonly promptCapabilities?: {
			readonly image?: boolean;
			readonly audio?: boolean;
			readonly embeddedContext?: boolean;
		};
		readonly sessionCapabilities?: {
			readonly resume?: Record<string, unknown>;
			readonly load?: Record<string, unknown>;
			readonly list?: Record<string, unknown>;
			readonly close?: Record<string, unknown>;
			readonly additionalDirectories?: Record<string, unknown>;
		};
		readonly auth?: {
			readonly logout?: Record<string, unknown>;
		};
	};
	readonly agentInfo?: {
		readonly name?: string;
		readonly version?: string;
	};
	readonly authMethods?: readonly AuthMethod[];
}

export interface AcpSelectOption {
	readonly value: string;
	readonly name: string;
	readonly description?: string;
	readonly group?: string;
}

export interface NormalizedConfigOption {
	readonly id: string;
	readonly name: string;
	readonly category?: string;
	readonly currentValue?: string;
	readonly options: readonly AcpSelectOption[];
}

export interface NormalizedSessionChoices {
	readonly models: readonly AcpSelectOption[];
	readonly currentModel?: string;
	readonly modelConfigId?: string;
	readonly modes: readonly AcpSelectOption[];
	readonly currentMode?: string;
	readonly modeConfigId?: string;
	readonly thoughtLevels: readonly AcpSelectOption[];
	readonly currentThoughtLevel?: string;
	readonly thoughtConfigId?: string;
	readonly configOptions: readonly NormalizedConfigOption[];
}

export interface AcpToolCallState {
	readonly id: string;
	title: string;
	kind?: string;
	status: string;
	rawInput?: unknown;
	rawOutput?: unknown;
	outputText?: string;
	locations: string[];
}

export interface AcpPlanEntry {
	readonly content: string;
	readonly priority?: string;
	readonly status: string;
}

export interface AcpUsageState {
	readonly used?: number;
	readonly size?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly costAmount?: number;
	readonly costCurrency?: string;
}

export interface AcpSlashCommand {
	readonly name: string;
	readonly description?: string;
}

export interface PermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind?: string;
}

export interface PermissionRequest {
	readonly sessionId?: string;
	readonly toolCall?: {
		readonly toolCallId?: string;
		readonly id?: string;
		readonly title?: string;
		readonly kind?: string;
		readonly rawInput?: unknown;
		readonly command?: string;
	};
	readonly options: readonly PermissionOption[];
}

export type PermissionOutcome =
	| { readonly outcome: "selected"; readonly optionId: string }
	| { readonly outcome: "cancelled" };

export interface SessionSummary {
	readonly sessionId: string;
	readonly cwd?: string;
	readonly title?: string;
	readonly updatedAt?: string;
}

export type PromptContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

export function encodeJsonRpc(message: JsonRpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
	return "id" in msg && msg.id !== undefined && !("method" in msg);
}

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
	return "id" in msg && msg.id !== undefined && "method" in msg && typeof msg.method === "string";
}

export function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
	return !("id" in msg && msg.id !== undefined) && "method" in msg && typeof msg.method === "string";
}

/**
 * Incremental newline-delimited JSON parser for ACP stdio streams.
 * Non-JSON diagnostic lines (if any) are surfaced via `onMalformed` rather than crashing.
 */
export function createNdjsonParser(
	onMessage: (message: JsonRpcMessage) => void,
	onMalformed?: (line: string, error: unknown) => void,
): (chunk: string | Uint8Array) => void {
	let buffer = "";
	return chunk => {
		buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const rawLine = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (rawLine.length > 0) {
				try {
					const parsed = JSON.parse(rawLine) as unknown;
					if (parsed !== null && typeof parsed === "object") {
						onMessage(parsed as JsonRpcMessage);
					}
				} catch (error) {
					onMalformed?.(rawLine, error);
				}
			}
			newlineIndex = buffer.indexOf("\n");
		}
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSelectOptions(raw: unknown): AcpSelectOption[] {
	if (!Array.isArray(raw)) return [];
	const out: AcpSelectOption[] = [];
	for (const item of raw) {
		const rec = asRecord(item);
		if (!rec) continue;
		// ACP supports grouped select options (`{ group, name, options: [...] }`) as well as flat options.
		if (Array.isArray(rec.options)) {
			const groupName = asString(rec.name) ?? asString(rec.group);
			for (const nested of rec.options) {
				const opt = asRecord(nested);
				const value = asString(opt?.value) ?? asString(opt?.id);
				const name = asString(opt?.name) ?? value;
				if (value !== undefined && name !== undefined) {
					out.push({ value, name, description: asString(opt?.description), group: groupName });
				}
			}
			continue;
		}
		const value = asString(rec.value) ?? asString(rec.id) ?? asString(rec.modelId) ?? asString(rec.modeId);
		const name = asString(rec.name) ?? value;
		if (value !== undefined && name !== undefined) {
			out.push({ value, name, description: asString(rec.description) });
		}
	}
	return out;
}

function normalizeConfigOptions(raw: unknown): NormalizedConfigOption[] {
	if (!Array.isArray(raw)) return [];
	const out: NormalizedConfigOption[] = [];
	for (const entry of raw) {
		const rec = asRecord(entry);
		if (!rec) continue;
		const id = asString(rec.configId) ?? asString(rec.id);
		if (!id) continue;
		out.push({
			id,
			name: asString(rec.name) ?? id,
			category: asString(rec.category),
			currentValue: asString(rec.currentValue),
			options: parseSelectOptions(rec.options),
		});
	}
	return out;
}

function findConfigOption(
	options: readonly NormalizedConfigOption[],
	categories: readonly string[],
	fallbackIds: readonly string[],
): NormalizedConfigOption | undefined {
	const byCategory = options.find(opt => opt.category !== undefined && categories.includes(opt.category));
	if (byCategory) return byCategory;
	return options.find(opt => fallbackIds.includes(opt.id));
}

/**
 * Normalizes both ACP v1 unified `configOptions` and legacy `models` / `modes`
 * payloads returned by `session/new`, `session/load`, `session/resume`, or
 * `config_option_update` notifications.
 */
export function normalizeSessionChoices(
	payload: unknown,
	previous?: NormalizedSessionChoices,
): NormalizedSessionChoices {
	const rec = asRecord(payload);
	const configOptions =
		rec && "configOptions" in rec ? normalizeConfigOptions(rec.configOptions) : [...(previous?.configOptions ?? [])];

	const modelOpt = findConfigOption(configOptions, ["model"], ["model", "model_id"]);
	const modeOpt = findConfigOption(configOptions, ["mode"], ["mode", "permission_mode"]);
	const thoughtOpt = findConfigOption(
		configOptions,
		["thought_level", "reasoning", "effort"],
		["thought_level", "reasoning_effort", "effort", "thinking"],
	);

	const legacyModels = asRecord(rec?.models);
	const legacyModes = asRecord(rec?.modes);

	const models = modelOpt?.options.length
		? modelOpt.options
		: legacyModels
			? parseSelectOptions(legacyModels.availableModels)
			: (previous?.models ?? []);
	const currentModel =
		modelOpt?.currentValue ?? asString(legacyModels?.currentModelId) ?? previous?.currentModel;

	const modes = modeOpt?.options.length
		? modeOpt.options
		: legacyModes
			? parseSelectOptions(legacyModes.availableModes)
			: (previous?.modes ?? []);
	const currentMode = modeOpt?.currentValue ?? asString(legacyModes?.currentModeId) ?? previous?.currentMode;

	const thoughtLevels = thoughtOpt?.options ?? previous?.thoughtLevels ?? [];
	const currentThoughtLevel = thoughtOpt?.currentValue ?? previous?.currentThoughtLevel;

	return {
		models,
		currentModel,
		modelConfigId: modelOpt?.id ?? previous?.modelConfigId,
		modes,
		currentMode,
		modeConfigId: modeOpt?.id ?? previous?.modeConfigId,
		thoughtLevels,
		currentThoughtLevel,
		thoughtConfigId: thoughtOpt?.id ?? previous?.thoughtConfigId,
		configOptions,
	};
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map(extractTextFromContent).filter(Boolean).join("\n");
	}
	const rec = asRecord(content);
	if (!rec) return "";
	if (typeof rec.text === "string") return rec.text;
	if ("content" in rec) return extractTextFromContent(rec.content);
	return "";
}

function extractLocations(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		const rec = asRecord(item);
		const locPath = asString(rec?.path) ?? asString(rec?.uri);
		if (!locPath) continue;
		const line = asNumber(rec?.line);
		out.push(line !== undefined ? `${locPath}:${line}` : locPath);
	}
	return out;
}

export interface TurnSnapshot {
	readonly thinking: string;
	readonly text: string;
	readonly toolCalls: readonly AcpToolCallState[];
	readonly plan: readonly AcpPlanEntry[];
	readonly usage?: AcpUsageState;
	readonly startedAt: number;
	readonly lastActivityAt: number;
}

/**
 * Accumulates ACP `session/update` notifications for a single `session/prompt` turn.
 * Every update advances `lastActivityAt`, preventing false timeouts during long
 * reasoning or tool phases.
 */
export class TurnAccumulator {
	thinking = "";
	text = "";
	readonly #toolMap = new Map<string, AcpToolCallState>();
	readonly #toolOrder: string[] = [];
	plan: AcpPlanEntry[] = [];
	usage: AcpUsageState | undefined;
	readonly startedAt: number;
	lastActivityAt: number;

	constructor(now = Date.now()) {
		this.startedAt = now;
		this.lastActivityAt = now;
	}

	applyUpdate(
		rawUpdate: unknown,
		now = Date.now(),
	): {
		kind?: string;
		currentMode?: string;
		choicesPatch?: unknown;
		commands?: AcpSlashCommand[];
	} {
		this.lastActivityAt = now;
		const update = asRecord(rawUpdate);
		if (!update) return {};

		const kind = asString(update.sessionUpdate) ?? asString(update.type);
		switch (kind) {
			case "agent_thought_chunk":
			case "thought": {
				const chunk = extractTextFromContent(update.content ?? update.text);
				if (chunk) this.thinking += chunk;
				return { kind };
			}
			case "agent_message_chunk": {
				const chunk = extractTextFromContent(update.content ?? update.text);
				if (chunk) this.text += chunk;
				return { kind };
			}
			case "tool_call":
			case "tool_call_update": {
				const id = asString(update.toolCallId) ?? asString(update.id);
				if (!id) return { kind };
				let entry = this.#toolMap.get(id);
				if (!entry) {
					entry = {
						id,
						title: asString(update.title) ?? asString(update.name) ?? id,
						kind: asString(update.kind),
						status: asString(update.status) ?? "pending",
						locations: [],
					};
					this.#toolMap.set(id, entry);
					this.#toolOrder.push(id);
				}
				const title = asString(update.title) ?? asString(update.name);
				if (title) entry.title = title;
				const toolKind = asString(update.kind);
				if (toolKind) entry.kind = toolKind;
				const status = asString(update.status);
				if (status) entry.status = status;
				if (update.rawInput !== undefined && update.rawInput !== null) entry.rawInput = update.rawInput;
				if (update.rawOutput !== undefined && update.rawOutput !== null) entry.rawOutput = update.rawOutput;
				const contentText = extractTextFromContent(update.content);
				if (contentText) entry.outputText = contentText;
				const locations = extractLocations(update.locations);
				if (locations.length > 0) entry.locations = locations;
				return { kind };
			}
			case "plan": {
				const entries = Array.isArray(update.entries) ? update.entries : [];
				this.plan = entries
					.map(item => asRecord(item))
					.filter((item): item is Record<string, unknown> => item !== undefined)
					.map(item => ({
						content: asString(item.content) ?? "",
						priority: asString(item.priority),
						status: asString(item.status) ?? "pending",
					}))
					.filter(item => item.content.length > 0);
				return { kind };
			}
			case "usage_update": {
				const cost = asRecord(update.cost);
				this.usage = {
					used: asNumber(update.used) ?? this.usage?.used,
					size: asNumber(update.size) ?? this.usage?.size,
					inputTokens: asNumber(update.inputTokens) ?? this.usage?.inputTokens,
					outputTokens: asNumber(update.outputTokens) ?? this.usage?.outputTokens,
					costAmount: asNumber(cost?.amount) ?? this.usage?.costAmount,
					costCurrency: asString(cost?.currency) ?? this.usage?.costCurrency,
				};
				return { kind };
			}
			case "current_mode_update": {
				return { kind, currentMode: asString(update.currentModeId) ?? asString(update.modeId) };
			}
			case "config_option_update": {
				return { kind, choicesPatch: update };
			}
			case "available_commands_update": {
				const rawCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
				const commands: AcpSlashCommand[] = [];
				for (const item of rawCommands) {
					const rec = asRecord(item);
					const name = asString(rec?.name);
					if (name) commands.push({ name, description: asString(rec?.description) });
				}
				return { kind, commands };
			}
			default:
				return { kind };
		}
	}

	snapshot(): TurnSnapshot {
		return {
			thinking: this.thinking,
			text: this.text,
			toolCalls: this.#toolOrder.map(id => ({ ...this.#toolMap.get(id)! })),
			plan: [...this.plan],
			usage: this.usage ? { ...this.usage } : undefined,
			startedAt: this.startedAt,
			lastActivityAt: this.lastActivityAt,
		};
	}
}

interface ManagedTerminal {
	readonly id: string;
	readonly child: ChildProcess;
	readonly outputByteLimit: number;
	buffer: Buffer;
	truncated: boolean;
	exited: boolean;
	exitCode: number | null;
	signal: string | null;
	readonly exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
}

const DEFAULT_TERMINAL_OUTPUT_LIMIT = 512 * 1024;

/**
 * Truncates a UTF-8 buffer from the front down to `limit` bytes without splitting
 * a multi-byte UTF-8 sequence.
 */
export function truncateUtf8Tail(buf: Buffer, limit: number): { buffer: Buffer; truncated: boolean } {
	if (limit <= 0) return { buffer: Buffer.alloc(0), truncated: buf.length > 0 };
	if (buf.length <= limit) return { buffer: buf, truncated: false };
	let start = buf.length - limit;
	// UTF-8 continuation bytes match 0b10xxxxxx (0x80..0xBF); advance past partial leading sequence.
	while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
		start++;
	}
	return { buffer: buf.subarray(start), truncated: true };
}

/**
 * Implements client-side ACP `fs/*` and `terminal/*` capabilities so an unmodified
 * `agy acp` binary can delegate reads, edits, and commands exactly as in T3 Code / Zed.
 */
export class AcpCapabilitiesHost {
	readonly #terminals = new Map<string, ManagedTerminal>();
	#nextTerminalId = 1;
	readonly #defaultCwd: () => string;

	constructor(getDefaultCwd: () => string) {
		this.#defaultCwd = getDefaultCwd;
	}

	async handleRequest(method: string, params: unknown): Promise<unknown> {
		const rec = asRecord(params) ?? {};
		switch (method) {
			case "fs/read_text_file":
				return this.#readTextFile(rec);
			case "fs/write_text_file":
				return this.#writeTextFile(rec);
			case "terminal/create":
				return this.#createTerminal(rec);
			case "terminal/output":
				return this.#terminalOutput(rec);
			case "terminal/wait_for_exit":
				return this.#waitForExit(rec);
			case "terminal/kill":
				return this.#killTerminal(rec);
			case "terminal/release":
				return this.#releaseTerminal(rec);
			default:
				throw new Error(`Unsupported ACP client capability method: ${method}`);
		}
	}

	async #readTextFile(params: Record<string, unknown>): Promise<{ content: string }> {
		const filePath = asString(params.path);
		if (!filePath) throw new Error("fs/read_text_file requires path");
		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(this.#defaultCwd(), filePath);
		const raw = await readFile(resolved, "utf8");
		const line = asNumber(params.line);
		const limit = asNumber(params.limit);
		if (line === undefined && limit === undefined) return { content: raw };
		const lines = raw.split(/\r?\n/);
		const startIdx = Math.max(0, (line ?? 1) - 1);
		const endIdx = limit !== undefined ? startIdx + Math.max(0, limit) : lines.length;
		return { content: lines.slice(startIdx, endIdx).join("\n") };
	}

	async #writeTextFile(params: Record<string, unknown>): Promise<Record<string, never>> {
		const filePath = asString(params.path);
		const content = asString(params.content);
		if (!filePath || content === undefined) throw new Error("fs/write_text_file requires path and content");
		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(this.#defaultCwd(), filePath);
		await mkdir(path.dirname(resolved), { recursive: true });
		await writeFile(resolved, content, "utf8");
		return {};
	}

	#createTerminal(params: Record<string, unknown>): { terminalId: string } {
		const command = asString(params.command);
		if (!command) throw new Error("terminal/create requires command");
		const args = Array.isArray(params.args) ? params.args.filter((a): a is string => typeof a === "string") : undefined;
		const cwd = asString(params.cwd) ?? this.#defaultCwd();
		const outputByteLimit = Math.max(1024, asNumber(params.outputByteLimit) ?? DEFAULT_TERMINAL_OUTPUT_LIMIT);

		const env: Record<string, string | undefined> = { ...process.env };
		if (Array.isArray(params.env)) {
			for (const pair of params.env) {
				const rec = asRecord(pair);
				const name = asString(rec?.name);
				const value = asString(rec?.value);
				if (name !== undefined && value !== undefined) env[name] = value;
			}
		}

		const id = `term_${this.#nextTerminalId++}`;
		const child =
			args && args.length > 0
				? spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
				: spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });

		let resolveExit!: (status: { exitCode: number | null; signal: string | null }) => void;
		const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
			resolveExit = resolve;
		});

		const term: ManagedTerminal = {
			id,
			child,
			outputByteLimit,
			buffer: Buffer.alloc(0),
			truncated: false,
			exited: false,
			exitCode: null,
			signal: null,
			exitPromise,
		};

		const append = (chunk: Buffer | string): void => {
			const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			const combined = Buffer.concat([term.buffer, piece]);
			const clipped = truncateUtf8Tail(combined, term.outputByteLimit);
			term.buffer = clipped.buffer;
			term.truncated = term.truncated || clipped.truncated;
		};

		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", err => {
			append(`\n${err.message}\n`);
			if (!term.exited) {
				term.exited = true;
				term.exitCode = 1;
				resolveExit({ exitCode: 1, signal: null });
			}
		});
		child.on("close", (code, signal) => {
			if (!term.exited) {
				term.exited = true;
				term.exitCode = code;
				term.signal = signal;
				resolveExit({ exitCode: code, signal });
			}
		});

		this.#terminals.set(id, term);
		return { terminalId: id };
	}

	#getTerminal(params: Record<string, unknown>): ManagedTerminal {
		const id = asString(params.terminalId);
		const term = id ? this.#terminals.get(id) : undefined;
		if (!term) throw new Error(`Unknown terminalId: ${String(id)}`);
		return term;
	}

	#terminalOutput(params: Record<string, unknown>): {
		output: string;
		truncated: boolean;
		exitStatus?: { exitCode: number | null; signal: string | null };
	} {
		const term = this.#getTerminal(params);
		return {
			output: term.buffer.toString("utf8"),
			truncated: term.truncated,
			...(term.exited ? { exitStatus: { exitCode: term.exitCode, signal: term.signal } } : {}),
		};
	}

	async #waitForExit(params: Record<string, unknown>): Promise<{ exitCode: number | null; signal: string | null }> {
		const term = this.#getTerminal(params);
		return term.exitPromise;
	}

	#killTerminal(params: Record<string, unknown>): Record<string, never> {
		const term = this.#getTerminal(params);
		if (!term.exited) {
			term.child.kill("SIGTERM");
		}
		return {};
	}

	#releaseTerminal(params: Record<string, unknown>): Record<string, never> {
		const term = this.#getTerminal(params);
		if (!term.exited) {
			term.child.kill("SIGTERM");
		}
		this.#terminals.delete(term.id);
		return {};
	}

	dispose(): void {
		for (const term of this.#terminals.values()) {
			if (!term.exited) {
				try {
					term.child.kill("SIGTERM");
				} catch {
					// Ignore already-exited processes during teardown.
				}
			}
		}
		this.#terminals.clear();
	}
}
