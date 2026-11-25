/**
 * Managed `agy acp` process client following T3 Code's thin-client ACP host
 * architecture:
 * - Spawns unmodified `agy acp --stdio` (never `--agent bridge`, never loopback
 *   tool hijacking, and never injecting `_meta.antigravity.systemPrompt.append`).
 * - Performs ACP v1 `initialize` with `clientInfo` (defaulting to `zed`, which unlocks the full Gemini + Claude + GPT-OSS catalog)
 *   and `clientCapabilities` (`fs` + `terminal`).
 * - Supports `session/new`, `session/list`, `session/resume` -> `session/load`,
 *   `session/set_config_option` (plus legacy `session/set_model` / `session/set_mode`),
 *   `session/prompt`, `session/cancel`, and interactive `session/request_permission`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AcpCapabilitiesHost,
	type AcpSlashCommand,
	type AuthMethod,
	createNdjsonParser,
	encodeJsonRpc,
	type InitializeResult,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	type JsonRpcError,
	type NormalizedSessionChoices,
	normalizeSessionChoices,
	type PermissionOutcome,
	type PermissionRequest,
	type PromptContentBlock,
	type SessionSummary,
	TurnAccumulator,
	type TurnSnapshot,
} from "./protocol.ts";

export type ApprovalPolicy = "ask" | "accept-edits" | "auto";

export interface AgyClientConfig {
	binaryPath?: string;
	extraArgs?: readonly string[];
	clientName?: string;
	clientTitle?: string;
	clientVersion?: string;
	forceFileStorage?: boolean;
	approvalPolicy?: ApprovalPolicy;
}

export interface AgyTurnResult {
	readonly stopReason: string;
	readonly snapshot: TurnSnapshot;
}

export interface AgyStatusSnapshot {
	readonly connected: boolean;
	readonly binaryPath?: string;
	readonly agentName?: string;
	readonly agentVersion?: string;
	readonly clientName: string;
	readonly sessionId?: string;
	readonly cwd?: string;
	readonly runningTurn: boolean;
	readonly choices: NormalizedSessionChoices;
	readonly authMethods: readonly AuthMethod[];
	readonly approvalPolicy: ApprovalPolicy;
	readonly commands: readonly AcpSlashCommand[];
}

export class AgyRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(err: JsonRpcError) {
		super(err.message);
		this.name = "AgyRpcError";
		this.code = err.code;
		this.data = err.data;
	}
}

export class AgyAuthRequiredError extends Error {
	readonly authMethods: readonly AuthMethod[];

	constructor(message: string, authMethods: readonly AuthMethod[]) {
		super(message);
		this.name = "AgyAuthRequiredError";
		this.authMethods = authMethods;
	}
}

function isExecutable(filePath: string): boolean {
	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Finds the unmodified Antigravity CLI binary (`agy`). Honors `OMP_AGY_ACP_BIN`
 * first, then `PATH`, then standard user installation locations.
 */
export function resolveAgyBinary(explicitPath?: string): string {
	const configured = explicitPath?.trim() || process.env.OMP_AGY_ACP_BIN?.trim();
	if (configured) {
		if (isExecutable(configured)) return configured;
		throw new Error(`Configured agy binary is not executable: ${configured}`);
	}

	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const home = os.homedir();
	const candidates = [
		...pathDirs.map(dir => path.join(dir, process.platform === "win32" ? "agy.exe" : "agy")),
		path.join(home, ".local", "bin", "agy"),
		path.join(home, ".omp", "antigravity-cli", "bin", "agy"),
		"/opt/homebrew/bin/agy",
		"/usr/local/bin/agy",
	];

	for (const candidate of candidates) {
		if (isExecutable(candidate)) return candidate;
	}

	throw new Error(
		"Could not find `agy` binary. Install Antigravity CLI (`agy`) on PATH or set OMP_AGY_ACP_BIN.",
	);
}

/**
 * Builds subprocess spawn configuration modeled on T3 Code's `AntigravityDriver`
 * without `--agent bridge` or `_meta.antigravity.systemPrompt.append`.
 */
export function buildAgySpawnSpec(config: AgyClientConfig = {}): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
} {
	const command = resolveAgyBinary(config.binaryPath);
	const args = ["acp", "--stdio", ...(config.extraArgs ?? [])];
	const env: NodeJS.ProcessEnv = { ...process.env };
	const forceFileStorage = config.forceFileStorage ?? process.env.OMP_AGY_FORCE_FILE_STORAGE === "1";
	if (forceFileStorage) {
		env.AGY_ACP_FORCE_FILE_STORAGE = "1";
	}
	return { command, args, env };
}

function looksLikeAuthError(error: unknown): boolean {
	if (error instanceof AgyRpcError) {
		if (error.code === -32000 || error.code === -32001) return true;
	}
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return (
		message.includes("not logged in") ||
		message.includes("authentication required") ||
		message.includes("auth required") ||
		message.includes("unauthenticated") ||
		message.includes("please log in")
	);
}

/**
 * Evaluates a permission request against the active client-side approval policy.
 * Returns `undefined` when interactive confirmation from the user is required.
 */
export function matchAutoApproval(
	request: PermissionRequest,
	policy: ApprovalPolicy,
): PermissionOutcome | undefined {
	if (policy === "ask") return undefined;
	const kind = request.toolCall?.kind?.toLowerCase() ?? "";
	const allowThis =
		policy === "auto" || (policy === "accept-edits" && (kind === "edit" || kind === "read" || kind === "search"));
	if (!allowThis) return undefined;

	const allowOption =
		request.options.find(opt => opt.kind === "allow_once") ??
		request.options.find(opt => opt.kind === "allow_always") ??
		request.options.find(opt => /allow|approve|accept|yes/i.test(opt.name));
	return allowOption ? { outcome: "selected", optionId: allowOption.optionId } : undefined;
}

interface PendingRpc {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly method: string;
}

export interface AgyClientCallbacks {
	onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionOutcome>;
	onChoicesChanged?: (choices: NormalizedSessionChoices) => void;
	onCommandsChanged?: (commands: readonly AcpSlashCommand[]) => void;
	onDiagnostic?: (line: string) => void;
}

export class AgyAcpClient {
	#config: AgyClientConfig;
	readonly #callbacks: AgyClientCallbacks;
	#child: ChildProcess | undefined;
	#capabilitiesHost: AcpCapabilitiesHost | undefined;
	#pending = new Map<number, PendingRpc>();
	#nextId = 1;
	#initResult: InitializeResult | undefined;
	#binaryPath: string | undefined;
	#sessionId: string | undefined;
	#sessionCwd: string | undefined;
	#choices: NormalizedSessionChoices = {
		models: [],
		modes: [],
		thoughtLevels: [],
		configOptions: [],
	};
	#commands: AcpSlashCommand[] = [];
	#activeTurn: TurnAccumulator | undefined;
	#activeTurnListener: ((snapshot: TurnSnapshot) => void) | undefined;
	#pendingPermissions = new Set<(outcome: PermissionOutcome) => void>();
	#connectPromise: Promise<void> | undefined;

	constructor(config: AgyClientConfig = {}, callbacks: AgyClientCallbacks = {}) {
		this.#config = { ...config };
		this.#callbacks = callbacks;
	}

	get clientName(): string {
		return this.#config.clientName?.trim() || process.env.OMP_AGY_ACP_CLIENT?.trim() || "zed";
	}

	get approvalPolicy(): ApprovalPolicy {
		return this.#config.approvalPolicy ?? "ask";
	}

	setApprovalPolicy(policy: ApprovalPolicy): void {
		this.#config = { ...this.#config, approvalPolicy: policy };
	}

	async setClientName(name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Client name cannot be empty");
		if (trimmed === this.clientName) return;
		this.#config = { ...this.#config, clientName: trimmed };
		await this.dispose();
	}

	status(): AgyStatusSnapshot {
		return {
			connected: this.#child !== undefined && this.#initResult !== undefined,
			binaryPath: this.#binaryPath,
			agentName: this.#initResult?.agentInfo?.name,
			agentVersion: this.#initResult?.agentInfo?.version,
			clientName: this.clientName,
			sessionId: this.#sessionId,
			cwd: this.#sessionCwd,
			runningTurn: this.#activeTurn !== undefined,
			choices: this.#choices,
			authMethods: this.#initResult?.authMethods ?? [],
			approvalPolicy: this.approvalPolicy,
			commands: this.#commands,
		};
	}

	async ensureConnected(): Promise<InitializeResult> {
		if (this.#child && this.#initResult) return this.#initResult;
		if (!this.#connectPromise) {
			this.#connectPromise = this.#connect().finally(() => {
				this.#connectPromise = undefined;
			});
		}
		await this.#connectPromise;
		return this.#initResult!;
	}

	async #connect(): Promise<void> {
		const spec = buildAgySpawnSpec(this.#config);
		this.#binaryPath = spec.command;
		const child = spawn(spec.command, spec.args, {
			env: spec.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child = child;
		this.#capabilitiesHost = new AcpCapabilitiesHost(() => this.#sessionCwd ?? process.cwd());

		const parseChunk = createNdjsonParser(
			msg => this.#handleIncomingMessage(msg),
			line => this.#callbacks.onDiagnostic?.(`non-json: ${line}`),
		);

		child.stdout?.on("data", parseChunk);
		child.stderr?.on("data", chunk => {
			const text = String(chunk).trim();
			if (text) this.#callbacks.onDiagnostic?.(text);
		});
		child.on("error", err => {
			this.#handleDisconnect(err);
		});
		child.on("exit", (code, signal) => {
			this.#handleDisconnect(new Error(`agy acp exited (${code ?? signal ?? "unknown"})`));
		});

		const init = (await this.#request("initialize", {
			protocolVersion: 1,
			clientInfo: {
				name: this.clientName,
				title: this.#config.clientTitle ?? (this.clientName === "t3-code" ? "T3 Code" : "Oh My Pi ACP Host"),
				version: this.#config.clientVersion ?? "0.0.46",
			},
			clientCapabilities: {
				fs: {
					readTextFile: true,
					writeTextFile: true,
				},
				terminal: true,
			},
		})) as InitializeResult;

		this.#initResult = init;
	}

	#handleDisconnect(reason: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const item of pending) item.reject(reason);

		for (const cancelPerm of this.#pendingPermissions) {
			cancelPerm({ outcome: "cancelled" });
		}
		this.#pendingPermissions.clear();
		this.#capabilitiesHost?.dispose();
		this.#capabilitiesHost = undefined;
		this.#child = undefined;
		this.#initResult = undefined;
		this.#sessionId = undefined;
		this.#activeTurn = undefined;
		this.#activeTurnListener = undefined;
	}

	#handleIncomingMessage(msg: JsonRpcMessage): void {
		if (isJsonRpcResponse(msg)) {
			const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			if (msg.error) {
				pending.reject(new AgyRpcError(msg.error));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}

		if (isJsonRpcRequest(msg)) {
			void this.#handleAgentRequest(msg.id, msg.method, msg.params);
			return;
		}

		if (isJsonRpcNotification(msg) && msg.method === "session/update") {
			this.#handleSessionUpdate(msg.params);
		}
	}

	async #handleAgentRequest(id: string | number, method: string, params: unknown): Promise<void> {
		try {
			if (method === "session/request_permission") {
				const outcome = await this.#resolvePermission(params as PermissionRequest);
				this.#send({ jsonrpc: "2.0", id, result: { outcome } });
				return;
			}
			if (!this.#capabilitiesHost) {
				throw new Error("ACP capabilities host is not initialized");
			}
			const result = await this.#capabilitiesHost.handleRequest(method, params);
			this.#send({ jsonrpc: "2.0", id, result });
		} catch (error) {
			this.#send({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	async #resolvePermission(request: PermissionRequest): Promise<PermissionOutcome> {
		const auto = matchAutoApproval(request, this.approvalPolicy);
		if (auto) return auto;

		if (!this.#callbacks.onPermissionRequest) {
			return { outcome: "cancelled" };
		}

		return new Promise<PermissionOutcome>(resolve => {
			let settled = false;
			const finish = (outcome: PermissionOutcome): void => {
				if (settled) return;
				settled = true;
				this.#pendingPermissions.delete(finish);
				resolve(outcome);
			};
			this.#pendingPermissions.add(finish);
			void this.#callbacks.onPermissionRequest!(request).then(finish, () => finish({ outcome: "cancelled" }));
		});
	}

	#handleSessionUpdate(params: unknown): void {
		if (!params || typeof params !== "object") return;
		const rec = params as Record<string, unknown>;
		const update = rec.update;
		if (this.#activeTurn) {
			const effect = this.#activeTurn.applyUpdate(update);
			if (effect.choicesPatch) {
				this.#choices = normalizeSessionChoices(effect.choicesPatch, this.#choices);
				this.#callbacks.onChoicesChanged?.(this.#choices);
			}
			if (effect.currentMode) {
				this.#choices = { ...this.#choices, currentMode: effect.currentMode };
				this.#callbacks.onChoicesChanged?.(this.#choices);
			}
			if (effect.commands) {
				this.#commands = effect.commands;
				this.#callbacks.onCommandsChanged?.(this.#commands);
			}
			this.#activeTurnListener?.(this.#activeTurn.snapshot());
			return;
		}

		// Replayed updates during `session/load` or idle configuration broadcasts.
		const probe = new TurnAccumulator();
		const effect = probe.applyUpdate(update);
		if (effect.choicesPatch) {
			this.#choices = normalizeSessionChoices(effect.choicesPatch, this.#choices);
			this.#callbacks.onChoicesChanged?.(this.#choices);
		}
		if (effect.currentMode) {
			this.#choices = { ...this.#choices, currentMode: effect.currentMode };
			this.#callbacks.onChoicesChanged?.(this.#choices);
		}
		if (effect.commands) {
			this.#commands = effect.commands;
			this.#callbacks.onCommandsChanged?.(this.#commands);
		}
	}

	#send(message: { jsonrpc: "2.0"; [key: string]: unknown }): void {
		if (!this.#child?.stdin?.writable) {
			throw new Error("agy acp process is not connected");
		}
		this.#child.stdin.write(encodeJsonRpc(message as never));
	}

	#request(method: string, params?: unknown): Promise<unknown> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject, method });
			try {
				this.#send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
			} catch (error) {
				this.#pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async ensureSession(cwd: string): Promise<{ sessionId: string; choices: NormalizedSessionChoices }> {
		const init = await this.ensureConnected();
		if (this.#sessionId && this.#sessionCwd === cwd) {
			return { sessionId: this.#sessionId, choices: this.#choices };
		}
		return this.newSession(cwd, init);
	}

	async newSession(cwd: string, init?: InitializeResult): Promise<{ sessionId: string; choices: NormalizedSessionChoices }> {
		const resolvedInit = init ?? (await this.ensureConnected());
		if (this.#sessionId) {
			await this.closeSession().catch(() => {});
		}
		try {
			const res = (await this.#request("session/new", { cwd, mcpServers: [] })) as Record<string, unknown>;
			const sessionId = typeof res?.sessionId === "string" ? res.sessionId : undefined;
			if (!sessionId) throw new Error("agy acp session/new did not return a sessionId");
			this.#sessionId = sessionId;
			this.#sessionCwd = cwd;
			this.#choices = normalizeSessionChoices(res);
			this.#callbacks.onChoicesChanged?.(this.#choices);
			return { sessionId, choices: this.#choices };
		} catch (error) {
			if (looksLikeAuthError(error)) {
				throw new AgyAuthRequiredError(
					error instanceof Error ? error.message : String(error),
					resolvedInit.authMethods ?? [],
				);
			}
			throw error;
		}
	}

	async listSessions(cwd?: string): Promise<SessionSummary[]> {
		const init = await this.ensureConnected();
		try {
			const res = (await this.#request("session/list", cwd ? { cwd } : {})) as Record<string, unknown>;
			const raw = Array.isArray(res?.sessions) ? res.sessions : [];
			return raw
				.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
				.map(item => ({
					sessionId: String(item.sessionId ?? ""),
					cwd: typeof item.cwd === "string" ? item.cwd : undefined,
					title: typeof item.title === "string" ? item.title : undefined,
					updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
				}))
				.filter(item => item.sessionId.length > 0);
		} catch (error) {
			if (looksLikeAuthError(error)) {
				throw new AgyAuthRequiredError(
					error instanceof Error ? error.message : String(error),
					init.authMethods ?? [],
				);
			}
			throw error;
		}
	}

	async resumeOrLoadSession(
		sessionId: string,
		cwd: string,
	): Promise<{ sessionId: string; choices: NormalizedSessionChoices }> {
		const init = await this.ensureConnected();
		const hasResume = init.agentCapabilities?.sessionCapabilities?.resume !== undefined;
		const method = hasResume ? "session/resume" : "session/load";
		try {
			const res = (await this.#request(method, { sessionId, cwd, mcpServers: [] })) as Record<string, unknown>;
			this.#sessionId = typeof res?.sessionId === "string" ? res.sessionId : sessionId;
			this.#sessionCwd = cwd;
			this.#choices = normalizeSessionChoices(res, this.#choices);
			this.#callbacks.onChoicesChanged?.(this.#choices);
			return { sessionId: this.#sessionId, choices: this.#choices };
		} catch (error) {
			if (hasResume) {
				// Match T3 Code fallback when `session/resume` fails for an older persisted session.
				const res = (await this.#request("session/load", { sessionId, cwd, mcpServers: [] })) as Record<
					string,
					unknown
				>;
				this.#sessionId = typeof res?.sessionId === "string" ? res.sessionId : sessionId;
				this.#sessionCwd = cwd;
				this.#choices = normalizeSessionChoices(res, this.#choices);
				this.#callbacks.onChoicesChanged?.(this.#choices);
				return { sessionId: this.#sessionId, choices: this.#choices };
			}
			throw error;
		}
	}

	async setModel(modelId: string, cwd: string): Promise<NormalizedSessionChoices> {
		const { sessionId, choices } = await this.ensureSession(cwd);
		const configId = choices.modelConfigId ?? (choices.configOptions.some(o => o.id === "model") ? "model" : undefined);
		const res = configId
			? await this.#request("session/set_config_option", { sessionId, configId, value: modelId })
			: await this.#request("session/set_model", { sessionId, modelId });
		this.#choices = normalizeSessionChoices(res ?? {}, { ...this.#choices, currentModel: modelId });
		this.#callbacks.onChoicesChanged?.(this.#choices);
		return this.#choices;
	}

	async setMode(modeId: string, cwd: string): Promise<NormalizedSessionChoices> {
		const { sessionId, choices } = await this.ensureSession(cwd);
		// Guard against `yolo` / unsupported mode rejections seen in T3 Code issues #32925 & #36105.
		if (choices.modes.length > 0 && !choices.modes.some(mode => mode.value === modeId)) {
			const advertised = choices.modes.map(m => m.value).join(", ");
			throw new Error(`Unsupported mode "${modeId}". Advertised modes: ${advertised}`);
		}
		const configId = choices.modeConfigId ?? (choices.configOptions.some(o => o.id === "mode") ? "mode" : undefined);
		const res = configId
			? await this.#request("session/set_config_option", { sessionId, configId, value: modeId })
			: await this.#request("session/set_mode", { sessionId, modeId });
		this.#choices = normalizeSessionChoices(res ?? {}, { ...this.#choices, currentMode: modeId });
		this.#callbacks.onChoicesChanged?.(this.#choices);
		return this.#choices;
	}

	async setThoughtLevel(level: string, cwd: string): Promise<NormalizedSessionChoices> {
		const { sessionId, choices } = await this.ensureSession(cwd);
		if (!choices.thoughtConfigId) {
			throw new Error("Active agy acp session does not expose a thought_level config option");
		}
		const res = await this.#request("session/set_config_option", {
			sessionId,
			configId: choices.thoughtConfigId,
			value: level,
		});
		this.#choices = normalizeSessionChoices(res ?? {}, { ...this.#choices, currentThoughtLevel: level });
		this.#callbacks.onChoicesChanged?.(this.#choices);
		return this.#choices;
	}

	async authenticate(methodId: string): Promise<void> {
		await this.ensureConnected();
		await this.#request("authenticate", { methodId });
	}

	async logout(): Promise<void> {
		await this.ensureConnected();
		await this.#request("auth/logout", {});
		this.#sessionId = undefined;
	}

	async prompt(
		cwd: string,
		blocks: readonly PromptContentBlock[],
		onUpdate?: (snapshot: TurnSnapshot) => void,
	): Promise<AgyTurnResult> {
		if (this.#activeTurn) {
			throw new Error("Gemini Agent already has an active turn running");
		}
		const { sessionId } = await this.ensureSession(cwd);
		const accumulator = new TurnAccumulator();
		this.#activeTurn = accumulator;
		this.#activeTurnListener = onUpdate;
		try {
			const res = (await this.#request("session/prompt", { sessionId, prompt: blocks })) as Record<
				string,
				unknown
			>;
			const stopReason = typeof res?.stopReason === "string" ? res.stopReason : "end_turn";
			return { stopReason, snapshot: accumulator.snapshot() };
		} finally {
			this.#activeTurn = undefined;
			this.#activeTurnListener = undefined;
		}
	}

	cancelTurn(): boolean {
		if (!this.#activeTurn || !this.#sessionId || !this.#child?.stdin?.writable) return false;
		for (const cancelPerm of this.#pendingPermissions) {
			cancelPerm({ outcome: "cancelled" });
		}
		this.#pendingPermissions.clear();
		this.#send({
			jsonrpc: "2.0",
			method: "session/cancel",
			params: { sessionId: this.#sessionId },
		});
		return true;
	}

	async closeSession(): Promise<void> {
		if (!this.#sessionId || !this.#child) return;
		const id = this.#sessionId;
		this.#sessionId = undefined;
		try {
			await this.#request("session/close", { sessionId: id });
		} catch {
			// Ignore close errors on already-terminated sessions.
		}
	}

	async dispose(): Promise<void> {
		if (this.#activeTurn) {
			this.cancelTurn();
		}
		await this.closeSession().catch(() => {});
		this.#capabilitiesHost?.dispose();
		this.#capabilitiesHost = undefined;
		const child = this.#child;
		if (!child) return;
		this.#child = undefined;
		this.#initResult = undefined;
		await new Promise<void>(resolve => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				resolve();
			};
			child.once("exit", finish);
			try {
				child.stdin?.end();
				child.kill("SIGTERM");
			} catch {
				finish();
			}
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
				finish();
			}, 750);
		});
	}
}
