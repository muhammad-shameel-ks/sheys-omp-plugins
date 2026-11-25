/**
 * Native Antigravity ACP provider for oh-my-pi (`omp`):
 * - Adds `agy` ("Antigravity ACP (agy)") directly to `/login`.
 * - Exposes Antigravity's Gemini models directly in `/models`.
 * - Streams turns through an unmodified `agy acp --stdio` host using T3 Code's
 *   thin-client ACP model (no `--agent bridge`, no `_meta.antigravity.systemPrompt.append`,
 *   no custom status indicators or widgets).
 */
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	AGY_API_NAME,
	AGY_BASE_URL,
	AGY_PROVIDER_NAME,
	AgyProviderRuntime,
	DEFAULT_AGY_MODELS,
	defaultCwd,
	type OmpStreamContext,
	type OmpStreamOptions,
} from "./provider.ts";
import type { PermissionOutcome, PermissionRequest } from "./protocol.ts";
import { agyUsageProvider } from "./usage.ts";

function formatPermissionChoice(request: PermissionRequest): { title: string; labels: string[] } {
	const tool = request.toolCall;
	const kind = tool?.kind ? ` [${tool.kind}]` : "";
	const raw = tool?.command ?? (tool?.rawInput !== undefined ? JSON.stringify(tool.rawInput) : "");
	const detail = raw ? `: ${String(raw).replace(/\s+/g, " ").slice(0, 80)}` : "";
	const title = `${tool?.title?.trim() || "Antigravity ACP permission"}${kind}${detail}`;
	const labels = request.options.map(opt => (opt.kind ? `${opt.name} (${opt.kind})` : opt.name));
	return { title, labels };
}

export default function agyAcp(pi: ExtensionAPI): void {
	pi.setLabel?.("Antigravity ACP");
	let latestCtx: ExtensionContext | undefined;

	const runtime = new AgyProviderRuntime({
		getCwd: () => latestCtx?.cwd ?? defaultCwd(),
		selectPermission: async (request: PermissionRequest): Promise<PermissionOutcome> => {
			if (!latestCtx?.hasUI) return { outcome: "cancelled" };
			const { title, labels } = formatPermissionChoice(request);
			if (labels.length === 0) return { outcome: "cancelled" };
			const chosen = await latestCtx.ui.select(title, labels);
			if (!chosen) return { outcome: "cancelled" };
			const idx = labels.indexOf(chosen);
			const opt = idx >= 0 ? request.options[idx] : undefined;
			return opt ? { outcome: "selected", optionId: opt.optionId } : { outcome: "cancelled" };
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") latestCtx = ctx;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") latestCtx = ctx;
	});

	for (const event of ["session_switch", "session_branch", "session_tree", "session_clear"] as const) {
		pi.on(event, async (_event, ctx) => {
			if (ctx.agent?.kind === "sub") return;
			latestCtx = ctx;
			await runtime.resetAllSessions();
		});
	}

	pi.on("session_shutdown", async () => {
		await runtime.dispose();
	});

	pi.registerProvider(AGY_PROVIDER_NAME, {
		baseUrl: AGY_BASE_URL,
		api: AGY_API_NAME,
		oauth: runtime.createOAuthConfig(),
		usage: agyUsageProvider,
		models: [...DEFAULT_AGY_MODELS],
		fetchDynamicModels: (apiKey?: string) => runtime.fetchDynamicModels(apiKey),
		streamSimple: (model, context, options) => {
			const stream = new AssistantMessageEventStream();
			runtime.runStream(
				model as { id: string; api: string; provider: string },
				context as OmpStreamContext,
				options as OmpStreamOptions | undefined,
				stream,
			);
			return stream;
		},
	});
}
