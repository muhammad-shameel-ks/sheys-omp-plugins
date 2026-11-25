/**
 * Unit and mock-ACP integration tests for the native `agy` provider (`agy-acp`).
 * Exercises NDJSON framing, configOptions/models/modes normalization,
 * TurnAccumulator, fs/terminal capability hosts, AgyAcpClient, AgyProviderRuntime
 * (`oauth`, `fetchDynamicModels`, `runStream`, `buildPromptBlocksFromContext`),
 * `index.ts` `pi.registerProvider("gemini-agent", ...)` wiring, and real `agy acp` initialize.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	AgyAcpClient,
	AgyAuthRequiredError,
	buildAgySpawnSpec,
	matchAutoApproval,
} from "./client.ts";
import {
	AcpCapabilitiesHost,
	createNdjsonParser,
	encodeJsonRpc,
	normalizeSessionChoices,
	truncateUtf8Tail,
	TurnAccumulator,
} from "./protocol.ts";
import {
	AGY_API_NAME,
	AGY_PROVIDER_NAME,
	AgyProviderRuntime,
	buildPromptBlocksFromContext,
	DEFAULT_AGY_MODELS,
	type OmpEventStreamLike,
	resolveWireModelId,
	toOmpModels,
} from "./provider.ts";
import { createAgyUsageProvider, decodeGoKeyringSecret, parseCliToken, parseQuotaSummary } from "./usage.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function createMockAgyBinary(mode: "ok" | "auth-required" = "ok"): Promise<{ binPath: string; logPath: string }> {
	const dir = await makeTempDir("agy-mock-");
	const logPath = path.join(dir, "received.jsonl");
	const scriptPath = path.join(dir, "mock-agy.mjs");
	const binPath = path.join(dir, "agy");

	const script = `
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const logPath = ${JSON.stringify(logPath)};
let mode = ${JSON.stringify(mode)};
const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

let activePromptId = null;
let turnCounter = 0;

rl.on("line", line => {
  if (!line.trim()) return;
  appendFileSync(logPath, line + "\\n");
  const msg = JSON.parse(line);

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, load: {}, list: {}, close: {} },
          auth: { logout: {} },
        },
        agentInfo: { name: "Mock Antigravity ACP", version: "1.5.16" },
        authMethods: [
          { id: "oauth-personal", name: "Log in with Google" },
          { id: "gemini-api-key", name: "Gemini API key" },
        ],
      },
    });
    return;
  }

  if (msg.method === "authenticate") {
    mode = "ok";
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/new") {
    if (mode === "auth-required") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess_mock_1",
        configOptions: [
          {
            configId: "model",
            name: "Model",
            category: "model",
            currentValue: "gemini-3.8-flash",
            options: [
              { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
              { value: "gemini-4-pro", name: "Gemini 4 Pro" },
            ],
          },
          {
            configId: "mode",
            name: "Mode",
            category: "mode",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "accept-edits", name: "Accept Edits" },
              { value: "plan", name: "Plan" },
            ],
          },
          {
            configId: "thought_level",
            name: "Thinking",
            category: "thought_level",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        configOptions: [
          {
            configId: "model",
            name: "Model",
            category: "model",
            currentValue: msg.params.configId === "model" ? msg.params.value : "gemini-3.8-flash",
            options: [
              { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
              { value: "gemini-4-pro", name: "Gemini 4 Pro" },
            ],
          },
          {
            configId: "thought_level",
            name: "Thinking",
            category: "thought_level",
            currentValue: msg.params.configId === "thought_level" ? msg.params.value : "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "session/prompt") {
    turnCounter++;
    activePromptId = msg.id;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } },
      },
    });
    if (turnCounter === 1) {
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "session/request_permission",
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: "call_1", title: "Read hello.txt", kind: "read" },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Turn 2 reply" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: activePromptId, result: { stopReason: "end_turn" } });
    activePromptId = null;
    return;
  }

  if (msg.id === 9001 && msg.result) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_mock_1",
        update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read hello.txt", kind: "read", status: "completed" },
      },
    });
    send({
      jsonrpc: "2.0",
      id: 9002,
      method: "fs/read_text_file",
      params: { path: "hello.txt" },
    });
    return;
  }

  if (msg.id === 9002) {
    const fileContent = msg.result?.content ?? "";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_mock_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Read: " + fileContent },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_mock_1",
        update: { sessionUpdate: "usage_update", used: 42, size: 1000, inputTokens: 20, outputTokens: 22 },
      },
    });
    send({ jsonrpc: "2.0", id: activePromptId, result: { stopReason: "end_turn" } });
    activePromptId = null;
    return;
  }

  if (msg.method === "session/cancel" && activePromptId !== null) {
    send({ jsonrpc: "2.0", id: activePromptId, result: { stopReason: "cancelled" } });
    activePromptId = null;
    return;
  }

  if (msg.method === "session/close" || msg.method === "auth/logout") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;
	await writeFile(scriptPath, script, "utf8");
	await writeFile(binPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`, {
		mode: 0o755,
	});
	return { binPath, logPath };
}

function collectStream(): {
	stream: OmpEventStreamLike;
	events: Array<Record<string, unknown>>;
	done: Promise<Record<string, unknown>>;
} {
	const events: Array<Record<string, unknown>> = [];
	let resolveDone!: (ev: Record<string, unknown>) => void;
	const done = new Promise<Record<string, unknown>>(resolve => {
		resolveDone = resolve;
	});
	const stream: OmpEventStreamLike = {
		push(ev) {
			events.push(ev);
			if (ev.type === "done" || ev.type === "error") resolveDone(ev);
		},
	};
	return { stream, events, done };
}

after(async () => {
	await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("protocol NDJSON framing and session normalization", () => {
	it("parses split/batched chunks and normalizes configOptions + legacy fields", () => {
		const messages: unknown[] = [];
		const malformed: string[] = [];
		const parse = createNdjsonParser(
			msg => messages.push(msg),
			line => malformed.push(line),
		);
		const a = encodeJsonRpc({ jsonrpc: "2.0", id: 1, result: { ok: true } });
		const b = encodeJsonRpc({ jsonrpc: "2.0", method: "session/update", params: { x: 2 } });
		parse(a.slice(0, 10));
		parse(`${a.slice(10)}bad\n${b}`);
		assert.equal(messages.length, 2);
		assert.deepEqual(malformed, ["bad"]);

		const choices = normalizeSessionChoices({
			configOptions: [
				{
					configId: "model",
					name: "Model",
					category: "model",
					currentValue: "gemini-3.8-flash",
					options: [{ name: "Gemini", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] }],
				},
			],
		});
		assert.equal(choices.currentModel, "gemini-3.8-flash");
		assert.equal(choices.models[0]?.group, "Gemini");

		const legacy = normalizeSessionChoices({
			models: { currentModelId: "gemini-2.5-pro", availableModels: [{ modelId: "gemini-2.5-pro", name: "Pro" }] },
			modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
		});
		assert.equal(legacy.currentModel, "gemini-2.5-pro");
		assert.equal(legacy.currentMode, "default");
	});

	it("accumulates TurnAccumulator updates and handles fs/terminal capabilities", async () => {
		const acc = new TurnAccumulator(100);
		acc.applyUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Think" } }, 200);
		acc.applyUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } }, 300);
		assert.equal(acc.snapshot().thinking, "Think");
		assert.equal(acc.snapshot().text, "Answer");
		assert.equal(acc.snapshot().lastActivityAt, 300);

		const dir = await makeTempDir("agy-cap-");
		const host = new AcpCapabilitiesHost(() => dir);
		await host.handleRequest("fs/write_text_file", { path: "a/b.txt", content: "1\n2\n3" });
		const read = (await host.handleRequest("fs/read_text_file", { path: "a/b.txt", line: 2, limit: 1 })) as {
			content: string;
		};
		assert.equal(read.content, "2");

		const clipped = truncateUtf8Tail(Buffer.from("a😀b", "utf8"), 4);
		assert.equal(clipped.truncated, true);
		assert.equal(clipped.buffer.toString("utf8").includes("\uFFFD"), false);

		const term = (await host.handleRequest("terminal/create", {
			command: process.execPath,
			args: ["-e", "console.log('ok')"],
		})) as { terminalId: string };
		const exit = (await host.handleRequest("terminal/wait_for_exit", { terminalId: term.terminalId })) as {
			exitCode: number | null;
		};
		assert.equal(exit.exitCode, 0);
		await host.handleRequest("terminal/release", { terminalId: term.terminalId });
		host.dispose();
	});

	it("builds unmodified agy acp spawn spec and evaluates approval policies", async () => {
		const dir = await makeTempDir("agy-spec-");
		const fakeBin = path.join(dir, "agy");
		await writeFile(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const spec = buildAgySpawnSpec({ binaryPath: fakeBin, forceFileStorage: true });
		assert.deepEqual(spec.args, ["acp", "--stdio"]);
		assert.equal(spec.env.AGY_ACP_FORCE_FILE_STORAGE, "1");

		const editReq = {
			toolCall: { title: "Edit", kind: "edit" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		};
		assert.equal(matchAutoApproval(editReq, "ask"), undefined);
		assert.deepEqual(matchAutoApproval(editReq, "accept-edits"), { outcome: "selected", optionId: "allow" });
	});
});

describe("buildPromptBlocksFromContext", () => {
	it("extracts only latest user turn normally, and summarizes prior turns when starting fresh mid-thread", () => {
		const blocks1 = buildPromptBlocksFromContext(
			[{ role: "user", content: [{ type: "text", text: "Hello" }] }],
			0,
		);
		assert.deepEqual(blocks1, [{ type: "text", text: "Hello" }]);

		const blocks2 = buildPromptBlocksFromContext(
			[
				{ role: "user", content: "First question" },
				{ role: "assistant", content: [{ type: "text", text: "First answer" }] },
				{
					role: "user",
					content: [
						{ type: "text", text: "Follow up" },
						{ type: "image", data: "Zm9v", mimeType: "image/png" },
					],
				},
			],
			0,
		);
		assert.equal(blocks2.length, 3);
		assert.match((blocks2[0] as { text: string }).text, /First question/);
		assert.equal((blocks2[1] as { text: string }).text, "Follow up");
		assert.equal(blocks2[2]?.type, "image");
	});
});

describe("AgyProviderRuntime", () => {
	it("fetches dynamic models, verifies /login oauth, and streams multi-turn ACP responses without systemPrompt", async () => {
		const workdir = await makeTempDir("agy-rt-");
		await writeFile(path.join(workdir, "hello.txt"), "hello-from-disk", "utf8");
		const { binPath, logPath } = await createMockAgyBinary("ok");

		const permCalls: string[] = [];
		const runtime = new AgyProviderRuntime(
			{
				getCwd: () => workdir,
				selectPermission: async req => {
					permCalls.push(req.toolCall?.title ?? "");
					return { outcome: "selected", optionId: "allow_once" };
				},
			},
			{ binaryPath: binPath },
		);

		try {
			const models = await runtime.fetchDynamicModels();
			assert.deepEqual(
				models.map(m => m.id),
				["gemini-3.8-flash", "gemini-4-pro"],
			);
			assert.deepEqual(models[0]?.thinking, { mode: "effort", efforts: ["low", "medium", "high", "xhigh"] });

			// Ephemeral call without sessionId runs cleanly in an isolated one-shot client
			const ephemeral = collectStream();
			runtime.runStream(
				{ id: "gemini-3.8-flash", api: AGY_API_NAME, provider: AGY_PROVIDER_NAME },
				{ messages: [{ role: "user", content: "Summarize" }] },
				undefined,
				ephemeral.stream,
			);
			const ephemeralDone = await ephemeral.done;
			assert.equal(ephemeralDone.type, "done");

			const oauth = runtime.createOAuthConfig();
			const progress: string[] = [];
			const creds = await oauth.login({
				onPrompt: async () => "",
				onProgress: msg => progress.push(msg),
			});
			assert.equal(oauth.getApiKey(creds), "agy-acp-session");
			assert.ok(progress.some(p => p.includes("Existing Gemini Agent login verified")));

			const s1 = collectStream();
			runtime.runStream(
				{ id: "gemini-4-pro", api: AGY_API_NAME, provider: AGY_PROVIDER_NAME },
				{
					systemPrompt: "SECRET OMP SYSTEM PROMPT THAT MUST NOT BE SENT",
					messages: [{ role: "user", content: "Read hello.txt" }],
					tools: [{ name: "bash" }],
				},
				{ sessionId: "omp-sess-1", reasoning: "high" },
				s1.stream,
			);
			const done1 = await s1.done;
			assert.equal(done1.type, "done");
			assert.equal(done1.reason, "stop");
			const msg1 = done1.message as { content: Array<{ type: string; thinking?: string; text?: string }>; usage: { totalTokens: number } };
			assert.match(msg1.content[0]?.thinking ?? "", /Thinking\.\.\./);
			assert.match(msg1.content[0]?.thinking ?? "", /\[read\] Read hello\.txt \(completed\)/);
			assert.equal(msg1.content[1]?.text, "Read: hello-from-disk");
			assert.equal(msg1.usage.totalTokens, 42);
			// Both the isolated ephemeral turn and turn 1 of omp-sess-1 triggered their own independent permission check.
			assert.deepEqual(permCalls, ["Read hello.txt", "Read hello.txt"]);

			// Turn 2 reuses the same ACP session without resending turn 1
			const s2 = collectStream();
			runtime.runStream(
				{ id: "gemini-4-pro", api: AGY_API_NAME, provider: AGY_PROVIDER_NAME },
				{
					systemPrompt: "SECRET OMP SYSTEM PROMPT THAT MUST NOT BE SENT",
					messages: [
						{ role: "user", content: "Read hello.txt" },
						msg1 as never,
						{ role: "user", content: "And next?" },
					],
					tools: [{ name: "bash" }],
				},
				{ sessionId: "omp-sess-1" },
				s2.stream,
			);
			const done2 = await s2.done;
			assert.equal(done2.type, "done");
			const msg2 = done2.message as { content: Array<{ type: string; text?: string }> };
			assert.equal(msg2.content.at(-1)?.text, "Turn 2 reply");

			const rawLog = await readFile(logPath, "utf8");
			assert.equal(rawLog.includes("SECRET OMP SYSTEM PROMPT"), false);
			assert.equal(rawLog.includes("systemPrompt"), false);
			assert.equal(rawLog.includes("--agent"), false);
			const initLines = rawLog
				.trim()
				.split("\n")
				.map(l => JSON.parse(l) as { method?: string; params?: Record<string, unknown> })
				.filter(m => m.method === "initialize");
			assert.equal((initLines[0]?.params?.clientInfo as { name?: string })?.name, "zed");
		} finally {
			await runtime.dispose();
		}
	});

	it("handles /login gemini-api-key prompt and auth-required fallback in fetchDynamicModels", async () => {
		const workdir = await makeTempDir("agy-auth-rt-");
		const { binPath } = await createMockAgyBinary("auth-required");
		const runtime = new AgyProviderRuntime({ getCwd: () => workdir }, { binaryPath: binPath });

		try {
			const fallbackModels = await runtime.fetchDynamicModels();
			assert.deepEqual(fallbackModels, DEFAULT_AGY_MODELS);

			const oauth = runtime.createOAuthConfig();
			const creds = await oauth.login({
				onSelect: async () => "gemini-api-key",
				onPrompt: async () => "AIza-mock-key",
			});
			assert.equal(oauth.getApiKey(creds), "AIza-mock-key");

			// Fallback when OAuthLoginCallbacks omits onSelect (uses numeric choice via onPrompt)
			let promptCount = 0;
			const creds2 = await oauth.login({
				onPrompt: async () => {
					promptCount++;
					return promptCount === 1 ? "2" : "AIza-fallback-key";
				},
			});
			assert.equal(oauth.getApiKey(creds2), "AIza-fallback-key");
		} finally {
			delete process.env.GEMINI_API_KEY;
			await runtime.dispose();
		}
	});
});

describe("index.ts native registerProvider wiring and real agy initialize smoke", () => {
	it("registers provider `gemini-agent` with oauth + models + fetchDynamicModels + streamSimple and cleans up on shutdown", async () => {
		const dir = await makeTempDir("agy-idx-");
		await writeFile(path.join(dir, "hello.txt"), "idx-ok", "utf8");
		const { binPath } = await createMockAgyBinary("ok");

		const hooks = registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "@oh-my-pi/pi-coding-agent" || specifier === "@oh-my-pi/pi-ai") {
					return { shortCircuit: true, url: `mock:${specifier}` };
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url === "mock:@oh-my-pi/pi-coding-agent") {
					return { shortCircuit: true, format: "module", source: "export {};" };
				}
				if (url === "mock:@oh-my-pi/pi-ai") {
					return {
						shortCircuit: true,
						format: "module",
						source: `
export class AssistantMessageEventStream {
  constructor() { this.events = []; this._resolve = null; this._promise = new Promise(r => { this._resolve = r; }); }
  push(ev) { this.events.push(ev); if (ev.type === "done" || ev.type === "error") this._resolve(ev); }
  result() { return this._promise; }
}
`,
					};
				}
				return nextLoad(url, context);
			},
		});

		const prevBin = process.env.OMP_AGY_ACP_BIN;
		process.env.OMP_AGY_ACP_BIN = binPath;
		try {
			const { default: agyAcp } = await import(`./index.ts?t=${Date.now()}`);
			const registered: Array<{ name: string; config: any }> = [];
			const handlers = new Map<string, (event: any, ctx: any) => any>();
			const commands: string[] = [];

			const mockPi: any = {
				registerProvider(name: string, config: any) {
					registered.push({ name, config });
				},
				registerCommand(name: string) {
					commands.push(name);
				},
				on(event: string, fn: any) {
					handlers.set(event, fn);
				},
			};

			const mockCtx: any = {
				cwd: dir,
				hasUI: true,
				ui: {
					async select(_title: string, items: string[]) {
						return items[0];
					},
				},
			};

			agyAcp(mockPi);
			assert.equal(commands.length, 0);
			assert.equal(registered.length, 1);
			assert.equal(registered[0]!.name, "gemini-agent");
			assert.equal(registered[0]!.config.api, AGY_API_NAME);
			assert.equal(registered[0]!.config.oauth.name, "Gemini Agent");

			await handlers.get("session_start")?.({}, mockCtx);

			const liveModels = await registered[0]!.config.fetchDynamicModels();
			assert.equal(liveModels[0].id, "gemini-3.8-flash");

			const stream = registered[0]!.config.streamSimple(
				{ id: "gemini-4-pro", api: AGY_API_NAME, provider: "gemini-agent" },
				{ messages: [{ role: "user", content: "Read hello.txt" }] },
				{ sessionId: "idx-sess" },
			);
			const finalEv = await stream.result();
			assert.equal(finalEv.type, "done");
			assert.equal(finalEv.message.content.at(-1).text, "Read: idx-ok");

			await handlers.get("session_clear")?.({}, mockCtx);
			await handlers.get("session_shutdown")?.({}, mockCtx);
		} finally {
			hooks.deregister();
			if (prevBin === undefined) delete process.env.OMP_AGY_ACP_BIN;
			else process.env.OMP_AGY_ACP_BIN = prevBin;
		}
	});

	it("performs real initialize handshake against local agy binary when present", async () => {
		const realAgy = "/Users/testuser/.local/bin/agy";
		const logDir = await makeTempDir("agy-real-");
		const client = new AgyAcpClient({
			binaryPath: realAgy,
			extraArgs: ["--cli_log_file", path.join(logDir, "agy.log")],
		});
		try {
			const init = await client.ensureConnected();
			assert.equal(init.protocolVersion, 1);
			assert.equal(init.agentInfo?.name, "Antigravity ACP Server");
			assert.ok(init.authMethods?.some(m => m.id === "oauth-personal"));
		} finally {
			await client.dispose();
		}
	});
});

describe("clientName default", () => {
	it('defaults to "zed" rather than "t3-code"', () => {
		const saved = process.env.OMP_AGY_ACP_CLIENT;
		delete process.env.OMP_AGY_ACP_CLIENT;
		try {
			const client = new AgyAcpClient({}, { onPermissionRequest: async () => ({ outcome: "cancelled" }) });
			assert.equal(client.clientName, "zed");
		} finally {
			if (saved !== undefined) process.env.OMP_AGY_ACP_CLIENT = saved;
		}
	});
});

describe("thinking efforts", () => {
	it("exposes xhigh for Hydrogen in DEFAULT_AGY_MODELS", () => {
		const hydrogen = DEFAULT_AGY_MODELS.find(m => m.id === "gemini-4-hydrogen");
		assert.ok(hydrogen);
		assert.ok(hydrogen.thinking?.efforts.includes("xhigh"));
	});

	it("collapses effort-variant wire IDs into one model", () => {
		const models = toOmpModels([
			{ value: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (low)" },
			{ value: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (xhigh)" },
			{ value: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (high)" },
			{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
		]);
		assert.deepEqual(
			models.map(m => m.id),
			["gemini-4-hydrogen", "gemini-3.8-flash"],
		);
		assert.deepEqual(models[0]!.thinking?.efforts, ["low", "high", "xhigh"]);
		assert.equal(models[0]!.name, "Gemini 4 Hydrogen");
	});

	it("resolves the wire model ID from requested effort", () => {
		const catalog = [
			{ value: "gemini-4-hydrogen-medium", name: "m" },
			{ value: "gemini-4-hydrogen-xhigh", name: "x" },
		];
		assert.equal(resolveWireModelId("gemini-4-hydrogen", "xhigh", catalog), "gemini-4-hydrogen-xhigh");
		assert.equal(resolveWireModelId("gemini-4-hydrogen", "low", catalog), "gemini-4-hydrogen-medium");
		assert.equal(resolveWireModelId("gemini-3.8-flash", "high", catalog), "gemini-3.8-flash");
	});
});

describe("agy usage provider (T3 Code-style)", () => {
	const NOW = Date.parse("2026-11-25T12:00:00Z");
	const credential = { type: "oauth" as const, refreshToken: "oauth-personal", accessToken: "agy-acp-session" };
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
	const token = { accessToken: "real-token", expiresAt: NOW + 3_600_000 };
	const make = (readToken: () => Promise<typeof token | undefined> = async () => token) =>
		createAgyUsageProvider({ readToken, now: () => NOW });

	it("decodes go-keyring secrets and CLI token JSON", () => {
		const inner = JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: "2026-11-25T13:00:00Z" } });
		const encoded = `go-keyring-base64:${Buffer.from(inner).toString("base64")}`;
		assert.equal(decodeGoKeyringSecret(encoded), inner);
		assert.equal(parseCliToken(decodeGoKeyringSecret(encoded))?.accessToken, "a");
		assert.equal(parseCliToken("not json"), undefined);
	});

	it("reads the keyring token, hits both hosts and parses string windows", async () => {
		const seen: { url: string; auth: string | null }[] = [];
		const report = await make().fetchUsage(
			{ provider: "agy", credential },
			{
				fetch: (async (url: string, init?: RequestInit) => {
					seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
					if (url.includes("userinfo")) return json({ id: "g-123" });
					if (url.startsWith("https://daily-") && url.endsWith("retrieveUserQuotaSummary")) {
						return json({
							groups: [
								{
									buckets: [
										{
											bucketId: "gemini-weekly",
											window: "weekly",
											remainingFraction: 0.5,
											resetTime: "2026-11-28T00:00:00Z",
										},
									],
								},
							],
						});
					}
					return json({});
				}) as typeof fetch,
			},
		);
		assert.ok(seen.every(c => c.auth === "Bearer real-token"));
		assert.ok(seen.some(c => c.url.startsWith("https://daily-cloudcode-pa.googleapis.com")));
		assert.ok(seen.some(c => c.url.startsWith("https://cloudcode-pa.googleapis.com")));
		const limit = report!.limits[0]!;
		assert.equal(limit.label, "Gemini · Weekly");
		assert.equal(limit.amount.remainingFraction, 0.5);
		assert.equal(limit.window?.durationMs, 604_800_000);
		assert.equal(limit.window?.resetsAt, Date.parse("2026-11-28T00:00:00Z"));
		assert.equal(limit.scope.accountId, "g-123");
		assert.ok(!limit.scope.shared);
	});

	it("marks 3p buckets as one shared Claude & GPT group", () => {
		const limits = parseQuotaSummary(
			{ buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 0.1, resetTime: "2026-11-25T15:00:00Z" }] },
			NOW,
		);
		assert.equal(limits[0]!.label, "Claude & GPT (shared) · 5-hour");
		assert.equal(limits[0]!.scope.shared, true);
		assert.equal(limits[0]!.scope.sharedGroup, "3p");
		assert.equal(limits[0]!.status, "warning");
		assert.equal(limits[0]!.window?.durationMs, 18_000_000);
	});

	it("hides the reset of an untouched rolling bucket", () => {
		const limits = parseQuotaSummary(
			{ buckets: [{ bucketId: "gemini-x", window: "5h", remainingFraction: 1, resetTime: new Date(NOW + 5 * 3_600_000).toISOString() }] },
			NOW,
		);
		assert.equal(limits[0]!.window?.resetsAt, undefined);
	});

	it("falls back to fetchAvailableModels when summaries are empty", async () => {
		const ops: string[] = [];
		const report = await make().fetchUsage(
			{ provider: "agy", credential },
			{
				fetch: (async (url: string) => {
					if (url.includes("userinfo")) return new Response("{}", { status: 401 });
					ops.push(url.split(":").pop()!);
					if (url.endsWith("retrieveUserQuotaSummary")) return json({ groups: [] });
					return json({
						models: {
							"claude-sonnet-4-6": { modelProvider: "MODEL_PROVIDER_ANTHROPIC", quotaInfo: { remainingFraction: 0.1 } },
						},
					});
				}) as typeof fetch,
			},
		);
		assert.ok(ops.includes("fetchAvailableModels"));
		assert.equal(report?.limits[0]?.id, "claude-quota");
		assert.equal(report?.limits[0]?.status, "warning");
	});

	it("returns null when no token or the token is expired", async () => {
		const ctx = { fetch: (async () => json({})) as typeof fetch };
		assert.equal(await make(async () => undefined).fetchUsage({ provider: "agy", credential }, ctx), null);
		assert.equal(
			await make(async () => ({ accessToken: "x", expiresAt: NOW - 1 })).fetchUsage({ provider: "agy", credential }, ctx),
			null,
		);
	});
});
