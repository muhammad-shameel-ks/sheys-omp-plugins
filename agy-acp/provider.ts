/**
 * Pure T3-Code-style ACP provider adapter for `oh-my-pi` (`omp`).
 *
 * Exposes Google Antigravity natively to `omp`'s `/login` (`oauth`) and `/models`
 * (`models` + `fetchDynamicModels` + `streamSimple`) without custom UI chrome,
 * status indicators, or slash commands.
 *
 * Key T3 Code safety invariants preserved here:
 * - Spawns unmodified `agy acp --stdio` (never `--agent bridge`).
 * - Never sends `_meta.antigravity.systemPrompt.append` or `context.systemPrompt`.
 * - Never mounts loopback MCP tool proxies (`mcpServers: []`).
 * - Identifies with `clientInfo.name` defaulting to `"t3-code"`.
 */
import os from "node:os";
import {
	AgyAcpClient,
	AgyAuthRequiredError,
	type ApprovalPolicy,
	resolveAgyBinary,
} from "./client.ts";
import type {
	AcpSelectOption,
	PermissionOutcome,
	PermissionRequest,
	PromptContentBlock,
	TurnSnapshot,
} from "./protocol.ts";

export const AGY_PROVIDER_NAME = "agy";
export const AGY_API_NAME = "t3-agy-acp";
export const AGY_BASE_URL = "https://antigravity-acp.invalid/";

export interface OmpModelCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export type OmpEffort = "low" | "medium" | "high" | "xhigh";

export interface OmpModelThinking {
	readonly mode: "effort" | "google-level" | "budget";
	readonly efforts: readonly OmpEffort[];
}

export interface OmpProviderModel {
	readonly id: string;
	readonly name: string;
	readonly api?: string;
	readonly reasoning: boolean;
	readonly thinking?: OmpModelThinking;
	readonly input: ("text" | "image")[];
	readonly cost: OmpModelCost;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

export interface OmpAssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface OmpAssistantMessage {
	role: "assistant";
	content: Array<{ type: "thinking"; thinking: string } | { type: "text"; text: string }>;
	api: string;
	provider: string;
	model: string;
	usage: OmpAssistantUsage;
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}

export interface OmpEventStreamLike {
	push(event: Record<string, unknown>): void;
	end?(): void;
}

export interface OmpContextMessage {
	readonly role: string;
	readonly content?: unknown;
}

export interface OmpStreamContext {
	readonly systemPrompt?: string;
	readonly messages: readonly OmpContextMessage[];
	readonly tools?: readonly unknown[];
}

export interface OmpStreamOptions {
	readonly apiKey?: string;
	readonly signal?: AbortSignal;
	readonly reasoning?: string;
	readonly sessionId?: string;
}

export interface OAuthCredentialsLike {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

export interface OAuthCallbacksLike {
	onAuth?(info: { url: string; instructions?: string }): void;
	onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
	onProgress?(message: string): void;
	onSelect?<T extends string>(options: { message: string; options: readonly { label: string; value: T }[] }): Promise<T>;
	signal?: AbortSignal;
}

export interface ProviderUiBridge {
	getCwd(): string;
	selectPermission?(request: PermissionRequest): Promise<PermissionOutcome>;
}

const ZERO_COST: OmpModelCost = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const ALL_EFFORTS: readonly OmpEffort[] = ["low", "medium", "high", "xhigh"];

const DEFAULT_THINKING: OmpModelThinking = {
	mode: "effort",
	efforts: ALL_EFFORTS,
};

/**
 * Fallback Gemini models exposed before dynamic discovery completes or prior to
 * first `/login`. Once `fetchDynamicModels` runs, live models from `agy acp`
 * replace/augment these entries.
 */
export const DEFAULT_AGY_MODELS: readonly OmpProviderModel[] = [
	{
		id: "gemini-4-hydrogen",
		name: "Gemini 4 Hydrogen",
		api: AGY_API_NAME,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh"] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-4-neon",
		name: "Gemini 4 Neon",
		api: AGY_API_NAME,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh"] },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		api: AGY_API_NAME,
		reasoning: true,
		thinking: DEFAULT_THINKING,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.8-pro",
		name: "Gemini 3.8 Pro",
		api: AGY_API_NAME,
		reasoning: true,
		thinking: DEFAULT_THINKING,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		api: AGY_API_NAME,
		reasoning: true,
		thinking: DEFAULT_THINKING,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: AGY_API_NAME,
		reasoning: true,
		thinking: DEFAULT_THINKING,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
];

const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;

export function toOmpModel(opt: AcpSelectOption, efforts?: readonly OmpEffort[]): OmpProviderModel {
	return {
		id: opt.value,
		name: opt.name,
		api: AGY_API_NAME,
		reasoning: true,
		thinking: efforts && efforts.length > 0 ? { mode: "effort", efforts } : DEFAULT_THINKING,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

/**
 * Maps the live ACP catalog to omp models, collapsing effort-variant wire IDs
 * (`gemini-4-hydrogen-xhigh`, `-high`, ...) into one entry whose
 * `thinking.efforts` lists every variant found.
 */
export function toOmpModels(options: readonly AcpSelectOption[]): OmpProviderModel[] {
	const order: string[] = [];
	const groups = new Map<string, { opt: AcpSelectOption; efforts: OmpEffort[] }>();
	for (const opt of options) {
		const match = EFFORT_SUFFIX.exec(opt.value);
		const baseId = match ? opt.value.slice(0, match.index) : opt.value;
		let group = groups.get(baseId);
		if (!group) {
			const baseName = match ? opt.name.replace(/\s*[-(]?\s*(low|medium|high|xhigh)\)?$/i, "").trim() || opt.name : opt.name;
			group = { opt: { ...opt, value: baseId, name: baseName }, efforts: [] };
			groups.set(baseId, group);
			order.push(baseId);
		}
		if (match) group.efforts.push(match[1] as OmpEffort);
	}
	return order.map(id => {
		const { opt, efforts } = groups.get(id)!;
		const sorted = ALL_EFFORTS.filter(e => efforts.includes(e));
		return toOmpModel(opt, sorted);
	});
}

/** Resolves the wire model ID for a collapsed model + requested effort. */
export function resolveWireModelId(
	modelId: string,
	reasoning: string | undefined,
	catalog: readonly AcpSelectOption[],
): string {
	if (catalog.some(o => o.value === modelId)) return modelId;
	const variants = ALL_EFFORTS.filter(e => catalog.some(o => o.value === `${modelId}-${e}`));
	if (variants.length === 0) return modelId;
	const want = (reasoning?.toLowerCase() === "max" ? "xhigh" : reasoning?.toLowerCase()) as OmpEffort | undefined;
	const pick = want && variants.includes(want) ? want : variants.includes("medium") ? "medium" : variants[0]!;
	return `${modelId}-${pick}`;
}

function defaultApprovalPolicy(): ApprovalPolicy {
	const raw = process.env.OMP_AGY_APPROVE?.trim().toLowerCase();
	if (raw === "accept-edits" || raw === "auto" || raw === "ask") return raw;
	return "ask";
}

function emptyUsage(): OmpAssistantUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function extractMessageBlocks(content: unknown): PromptContentBlock[] {
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) return [];
	const out: PromptContentBlock[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const rec = part as Record<string, unknown>;
		if (rec.type === "text" && typeof rec.text === "string" && rec.text.length > 0) {
			out.push({ type: "text", text: rec.text });
		} else if (rec.type === "image" && typeof rec.data === "string" && typeof rec.mimeType === "string") {
			out.push({ type: "image", data: rec.data, mimeType: rec.mimeType });
		}
	}
	return out;
}

function extractPlainText(content: unknown): string {
	return extractMessageBlocks(content)
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map(b => b.text)
		.join("\n");
}

/**
 * Extracts only the unsent user turn (plus condensed prior non-system messages
 * when starting a fresh ACP session mid-conversation) so `omp`'s system prompt
 * and tool definitions are never sent to `agy acp`.
 */
export function buildPromptBlocksFromContext(
	messages: readonly OmpContextMessage[],
	sentCount: number,
): PromptContentBlock[] {
	const startIndex = Math.max(0, Math.min(sentCount, messages.length));
	const unsent = messages.slice(startIndex);
	if (unsent.length === 0) return [];

	// If prior messages already existed (e.g. user switched models mid-thread),
	// include a concise plain-text transcript before the latest user message.
	let lastUserIdx = -1;
	for (let i = unsent.length - 1; i >= 0; i--) {
		if (unsent[i]!.role === "user") {
			lastUserIdx = i;
			break;
		}
	}

	if (lastUserIdx === -1) {
		const fallbackText = unsent
			.map(m => `${m.role}: ${extractPlainText(m.content)}`.trim())
			.filter(Boolean)
			.join("\n\n");
		return fallbackText ? [{ type: "text", text: fallbackText }] : [];
	}

	const prior = unsent.slice(0, lastUserIdx).filter(m => m.role === "user" || m.role === "assistant");
	const latestBlocks = extractMessageBlocks(unsent[lastUserIdx]!.content);
	if (prior.length === 0) return latestBlocks;

	const historyLines = prior
		.map(m => {
			const text = extractPlainText(m.content).trim();
			return text ? `${m.role === "user" ? "User" : "Assistant"}: ${text}` : "";
		})
		.filter(Boolean);

	if (historyLines.length === 0) return latestBlocks;
	return [
		{ type: "text", text: `[Prior conversation context]\n${historyLines.join("\n\n")}\n\n[Current message]` },
		...latestBlocks,
	];
}

function formatToolLines(snapshot: TurnSnapshot, printedStatus: Map<string, string>): string {
	const added: string[] = [];
	for (const tool of snapshot.toolCalls) {
		const prev = printedStatus.get(tool.id);
		if (prev === tool.status) continue;
		printedStatus.set(tool.id, tool.status);
		const kind = tool.kind ? `[${tool.kind}] ` : "";
		const loc = tool.locations.length > 0 ? ` @ ${tool.locations.join(", ")}` : "";
		added.push(`• ${kind}${tool.title}${loc} (${tool.status})\n`);
	}
	return added.join("");
}

function resolveThoughtOption(
	reasoning: string | undefined,
	options: readonly AcpSelectOption[],
): string | undefined {
	if (!reasoning || options.length === 0) return undefined;
	const target = reasoning.toLowerCase();
	const exact = options.find(o => o.value.toLowerCase() === target || o.name.toLowerCase() === target);
	if (exact) return exact.value;
	if (target === "xhigh" || target === "max") {
		return options.find(o => /high|max/i.test(o.value))?.value ?? options.at(-1)?.value;
	}
	return undefined;
}

interface SessionTracker {
	readonly client: AgyAcpClient;
	sentCount: number;
	queue: Promise<void>;
}

/**
 * Manages per-session `agy acp` subprocesses, native `/login` OAuth probing,
 * dynamic `/models` discovery, and `AssistantMessageEventStream` translation.
 */
export class AgyProviderRuntime {
	readonly #ui: ProviderUiBridge;
	readonly #sessions = new Map<string, SessionTracker>();
	readonly #clientConfig: { binaryPath?: string; clientName?: string };

	constructor(ui: ProviderUiBridge, clientConfig: { binaryPath?: string; clientName?: string } = {}) {
		this.#ui = ui;
		this.#clientConfig = clientConfig;
	}

	#makeClient(): AgyAcpClient {
		return new AgyAcpClient(
			{
				binaryPath: this.#clientConfig.binaryPath,
				clientName: this.#clientConfig.clientName,
				approvalPolicy: defaultApprovalPolicy(),
			},
			{
				onPermissionRequest: async req => {
					if (this.#ui.selectPermission) return this.#ui.selectPermission(req);
					return { outcome: "cancelled" };
				},
			},
		);
	}

	#getTracker(sessionKey: string): SessionTracker {
		let tracker = this.#sessions.get(sessionKey);
		if (!tracker) {
			tracker = { client: this.#makeClient(), sentCount: 0, queue: Promise.resolve() };
			this.#sessions.set(sessionKey, tracker);
		}
		return tracker;
	}

	async fetchDynamicModels(apiKey?: string): Promise<OmpProviderModel[]> {
		const client = this.#makeClient();
		const envApiKey =
			apiKey && apiKey !== "agy-acp" && apiKey !== "agy-acp-session" ? apiKey : undefined;
		try {
			resolveAgyBinary(this.#clientConfig.binaryPath);
			const init = await Promise.race([
				client.ensureConnected(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("agy acp init timeout")), 10_000)),
			]);
			if (envApiKey && init.authMethods?.some(m => m.id === "gemini-api-key")) {
				process.env.GEMINI_API_KEY ??= envApiKey;
			}
			const { choices } = await Promise.race([
				client.newSession(this.#ui.getCwd(), init),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("agy acp models timeout")), 10_000)),
			]);
			if (choices.models.length > 0) {
				return toOmpModels(choices.models);
			}
			return [...DEFAULT_AGY_MODELS];
		} catch (error) {
			if (error instanceof AgyAuthRequiredError) {
				return [...DEFAULT_AGY_MODELS];
			}
			return [...DEFAULT_AGY_MODELS];
		} finally {
			await client.dispose();
		}
	}

	createOAuthConfig() {
		return {
			name: "Gemini Agent",
			login: async (callbacks: OAuthCallbacksLike): Promise<OAuthCredentialsLike> => {
				resolveAgyBinary(this.#clientConfig.binaryPath);
				const client = this.#makeClient();
				try {
					callbacks.onProgress?.("Connecting to agy acp...");
					const init = await client.ensureConnected();

					// First probe if agy already has a valid local login so `/login` -> `agy`
					// works seamlessly without forcing a redundant browser sign-in.
					if (process.env.OMP_AGY_FORCE_RELOGIN !== "1") {
						let alreadyAuthenticated = false;
						try {
							await client.newSession(this.#ui.getCwd(), init);
							await client.closeSession();
							alreadyAuthenticated = true;
						} catch (err) {
							if (!(err instanceof AgyAuthRequiredError)) throw err;
						}

						if (alreadyAuthenticated) {
							callbacks.onProgress?.("Existing agy login verified.");
							return {
								refresh: "oauth-personal",
								access: "agy-acp-session",
								expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
							};
						}
					}

					const methods = init.authMethods ?? [{ id: "oauth-personal", name: "Log in with Google" }];
					let methodId = methods[0]?.id ?? "oauth-personal";
					if (methods.length > 1) {
						if (callbacks.onSelect) {
							methodId = await callbacks.onSelect({
								message: "Gemini Agent login method",
								options: methods.map(m => ({ label: `${m.name} (${m.id})`, value: m.id })),
							});
						} else {
							const choices = methods.map((m, idx) => `${idx + 1}=${m.name} (${m.id})`).join(", ");
							const answer = (
								await callbacks.onPrompt({
									message: `Gemini Agent login method [${choices}] (default 1):`,
									placeholder: "1",
								})
							).trim();
							const idx = Number.parseInt(answer, 10) - 1;
							if (Number.isInteger(idx) && idx >= 0 && idx < methods.length) {
								methodId = methods[idx]!.id;
							} else if (answer && methods.some(m => m.id === answer)) {
								methodId = answer;
							}
						}
					}

					if (methodId === "gemini-api-key") {
						const key = (await callbacks.onPrompt({ message: "Enter Gemini API key:" })).trim();
						if (!key) throw new Error("Gemini API key cannot be empty");
						process.env.GEMINI_API_KEY = key;
						await client.authenticate(methodId);
						return {
							refresh: methodId,
							access: key,
							expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
						};
					}

					callbacks.onProgress?.(`Authenticating with agy acp (${methodId})...`);
					try {
						await client.authenticate(methodId);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						throw new Error(
							`agy acp authenticate (${methodId}) failed: ${msg}. Run \`agy acp --login\` once in a terminal, then retry /login -> agy.`,
						);
					}

					return {
						refresh: methodId,
						access: "agy-acp-session",
						expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
					};
				} finally {
					await client.dispose();
				}
			},
			refreshToken: async (credentials: OAuthCredentialsLike): Promise<OAuthCredentialsLike> => {
				return {
					...credentials,
					expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
				};
			},
			getApiKey: (credentials: OAuthCredentialsLike): string => credentials.access || "agy-acp-session",
		};
	}

	runStream(
		model: { id: string; api: string; provider: string },
		context: OmpStreamContext,
		options: OmpStreamOptions | undefined,
		stream: OmpEventStreamLike,
	): void {
		const isEphemeral = !options?.sessionId;
		const tracker: SessionTracker = isEphemeral
			? { client: this.#makeClient(), sentCount: 0, queue: Promise.resolve() }
			: this.#getTracker(options.sessionId!);

		const run = async (): Promise<void> => {
			const output: OmpAssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};

			if (options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				return;
			}

			if (options?.apiKey && options.apiKey !== "agy-acp" && options.apiKey !== "agy-acp-session") {
				process.env.GEMINI_API_KEY ??= options.apiKey;
			}

			stream.push({ type: "start", partial: output });

			const cwd = this.#ui.getCwd();
			let thinkingIdx = -1;
			let textIdx = -1;
			let thinkingClosed = false;
			let textClosed = false;
			let emittedThinkingLen = 0;
			let emittedTextLen = 0;
			const printedTools = new Map<string, string>();

			const ensureThinkingOpen = (): number => {
				if (thinkingIdx !== -1 && !thinkingClosed) return thinkingIdx;
				thinkingIdx = output.content.push({ type: "thinking", thinking: "" }) - 1;
				thinkingClosed = false;
				stream.push({ type: "thinking_start", contentIndex: thinkingIdx, partial: output });
				return thinkingIdx;
			};

			const appendThinking = (delta: string): void => {
				if (!delta) return;
				const idx = ensureThinkingOpen();
				const block = output.content[idx] as { type: "thinking"; thinking: string };
				block.thinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
			};

			const closeThinkingIfOpen = (): void => {
				if (thinkingIdx === -1 || thinkingClosed) return;
				thinkingClosed = true;
				const block = output.content[thinkingIdx] as { type: "thinking"; thinking: string };
				stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: block.thinking, partial: output });
			};

			const ensureTextOpen = (): number => {
				closeThinkingIfOpen();
				if (textIdx !== -1 && !textClosed) return textIdx;
				textIdx = output.content.push({ type: "text", text: "" }) - 1;
				textClosed = false;
				stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
				return textIdx;
			};

			const appendText = (delta: string): void => {
				if (!delta) return;
				const idx = ensureTextOpen();
				const block = output.content[idx] as { type: "text"; text: string };
				block.text += delta;
				stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
			};

			const closeTextIfOpen = (): void => {
				if (textIdx === -1 || textClosed) return;
				textClosed = true;
				const block = output.content[textIdx] as { type: "text"; text: string };
				stream.push({ type: "text_end", contentIndex: textIdx, content: block.text, partial: output });
			};

			const onAbort = (): void => {
				tracker.client.cancelTurn();
			};
			options?.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				if (context.messages.length <= tracker.sentCount) {
					tracker.sentCount = 0;
					await tracker.client.newSession(cwd);
				} else {
					await tracker.client.ensureSession(cwd);
				}

				const currentStatus = tracker.client.status();
				const wireModelId = resolveWireModelId(model.id, options?.reasoning, currentStatus.choices.models);
				if (wireModelId && currentStatus.choices.currentModel !== wireModelId) {
					await tracker.client.setModel(wireModelId, cwd).catch(() => {});
				}
				const targetThought = resolveThoughtOption(options?.reasoning, currentStatus.choices.thoughtLevels);
				if (targetThought && currentStatus.choices.currentThoughtLevel !== targetThought) {
					await tracker.client.setThoughtLevel(targetThought, cwd).catch(() => {});
				}

				const promptBlocks = buildPromptBlocksFromContext(context.messages, tracker.sentCount);
				if (promptBlocks.length === 0) {
					throw new Error("No user prompt content found to send to agy acp");
				}

				const result = await tracker.client.prompt(cwd, promptBlocks, snapshot => {
					if (snapshot.thinking.length > emittedThinkingLen) {
						const delta = snapshot.thinking.slice(emittedThinkingLen);
						emittedThinkingLen = snapshot.thinking.length;
						appendThinking(delta);
					}
					const toolLines = formatToolLines(snapshot, printedTools);
					if (toolLines) {
						appendThinking(toolLines);
					}
					if (snapshot.text.length > emittedTextLen) {
						const delta = snapshot.text.slice(emittedTextLen);
						emittedTextLen = snapshot.text.length;
						appendText(delta);
					}
				});

				// Flush any final chunks from snapshot that arrived synchronously with response.
				if (result.snapshot.thinking.length > emittedThinkingLen) {
					appendThinking(result.snapshot.thinking.slice(emittedThinkingLen));
				}
				const finalToolLines = formatToolLines(result.snapshot, printedTools);
				if (finalToolLines) appendThinking(finalToolLines);
				if (result.snapshot.text.length > emittedTextLen) {
					appendText(result.snapshot.text.slice(emittedTextLen));
				}

				closeThinkingIfOpen();
				closeTextIfOpen();

				if (result.snapshot.usage) {
					const u = result.snapshot.usage;
					output.usage.input = u.inputTokens ?? 0;
					output.usage.output = u.outputTokens ?? 0;
					output.usage.totalTokens = u.used ?? output.usage.input + output.usage.output;
					if (u.costAmount !== undefined) {
						output.usage.cost.total = u.costAmount;
					}
				}

				if (options?.signal?.aborted || result.stopReason === "cancelled") {
					output.stopReason = "aborted";
					output.errorMessage = "Aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
					return;
				}

				tracker.sentCount = context.messages.length + 1;
				output.stopReason = result.stopReason === "max_tokens" ? "length" : "stop";
				stream.push({ type: "done", reason: output.stopReason, message: output });
			} catch (error) {
				closeThinkingIfOpen();
				closeTextIfOpen();
				const aborted = options?.signal?.aborted === true;
				output.stopReason = aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
			} finally {
				options?.signal?.removeEventListener("abort", onAbort);
				if (isEphemeral) {
					await tracker.client.dispose();
				}
			}
		};

		// Serialize turns on the same ACP session to avoid overlapping session/prompt calls.
		tracker.queue = tracker.queue.then(run, run);
	}

	async resetAllSessions(): Promise<void> {
		await this.dispose();
	}

	async dispose(): Promise<void> {
		const clients = [...this.#sessions.values()].map(s => s.client);
		this.#sessions.clear();
		await Promise.all(clients.map(c => c.dispose()));
	}
}

export function defaultCwd(): string {
	return process.cwd() || os.homedir();
}
