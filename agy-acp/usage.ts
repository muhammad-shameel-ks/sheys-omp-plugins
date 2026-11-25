/**
 * `/usage` provider for Antigravity, mirroring T3 Code's Antigravity limits probe:
 * reads the sign-in `agy` already keeps (OS keyring / token file) at call time,
 * never persists it, and queries the Cloud Code quota endpoints.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const PROVIDER_ID = "agy";

// Consumer tiers are metered on the daily host, GCP-terms tiers on prod.
const ENDPOINTS: Record<string, readonly string[]> = {
	"oauth-personal": [DAILY_ENDPOINT, PROD_ENDPOINT],
	"oauth-business": [PROD_ENDPOINT, DAILY_ENDPOINT],
};

const SUMMARY_WINDOW_MINS = new Map([
	["5h", 5 * 60],
	["weekly", 7 * 24 * 60],
]);

export interface UsageCredentialLike {
	type?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	accountId?: string;
	projectId?: string;
	email?: string;
}

export interface UsageFetchParams {
	provider: string;
	credential: UsageCredentialLike;
	baseUrl?: string;
	signal?: AbortSignal;
}

export interface UsageFetchContext {
	fetch: typeof fetch;
	logger?: unknown;
}

export interface UsageLimitLike {
	id: string;
	label: string;
	scope: {
		provider: string;
		accountId?: string;
		projectId?: string;
		windowId?: string;
		shared?: boolean;
		sharedGroup?: string;
	};
	window?: { id: string; label: string; durationMs?: number; resetsAt?: number };
	amount: {
		used?: number;
		limit?: number;
		remaining?: number;
		usedFraction?: number;
		remainingFraction?: number;
		unit: string;
	};
	status?: "ok" | "warning" | "exhausted" | "unknown";
}

export interface UsageReportLike {
	provider: string;
	fetchedAt: number;
	limits: UsageLimitLike[];
	metadata?: Record<string, unknown>;
	raw?: unknown;
}

export interface AgyCliToken {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

export function antigravityUserAgent(platform: string = process.platform, arch: string = process.arch): string {
	return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${arch}; cl=963137146)`;
}

// ---------------------------------------------------------------------------
// Token discovery (read-only; same sources T3 Code uses)
// ---------------------------------------------------------------------------

/** go-keyring stores UTF-8, which it prefixes and encodes on macOS. */
export function decodeGoKeyringSecret(secret: string): string {
	if (secret.startsWith("go-keyring-base64:")) {
		return Buffer.from(secret.slice("go-keyring-base64:".length), "base64").toString("utf8");
	}
	if (secret.startsWith("go-keyring-encoded:")) {
		return Buffer.from(secret.slice("go-keyring-encoded:".length), "hex").toString("utf8");
	}
	return secret;
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(cmd, args, { timeout: 5_000, maxBuffer: 1 << 20 }, (err, stdout) => {
			if (err) return resolve(undefined);
			const out = stdout.replace(/\r?\n$/, "");
			resolve(out.length > 0 ? out : undefined);
		});
	});
}

async function readKeyringSecret(): Promise<string | undefined> {
	let raw: string | undefined;
	if (process.platform === "darwin") {
		raw = await run("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
	} else if (process.platform === "linux") {
		raw = await run("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"]);
	}
	return raw ? decodeGoKeyringSecret(raw) : undefined;
}

async function readTokenFile(): Promise<string | undefined> {
	const home = os.homedir();
	const candidates = [
		path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
		path.join(home, ".gemini", "antigravity-acp", "antigravity-oauth-token"),
	];
	for (const file of candidates) {
		try {
			return await readFile(file, "utf8");
		} catch {
			// try next
		}
	}
	return undefined;
}

export function parseCliToken(stored: string): AgyCliToken | undefined {
	try {
		const parsed = JSON.parse(stored) as { token?: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown } };
		const token = parsed.token;
		if (!token || typeof token.access_token !== "string" || token.access_token.length === 0) return undefined;
		const expiry = typeof token.expiry === "string" ? Date.parse(token.expiry) : Number.NaN;
		return {
			accessToken: token.access_token,
			refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
			expiresAt: Number.isFinite(expiry) ? expiry : undefined,
		};
	} catch {
		return undefined;
	}
}

/** Reads `agy`'s saved sign-in: token file first, then the OS keyring. */
export async function readAgyCliToken(): Promise<AgyCliToken | undefined> {
	const stored = (await readTokenFile()) ?? (await readKeyringSecret());
	return stored ? parseCliToken(stored) : undefined;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function rec(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

function statusFor(remainingFraction: number): UsageLimitLike["status"] {
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction < 0.2) return "warning";
	return "ok";
}

function makeLimit(
	id: string,
	label: string,
	remainingFraction: number,
	resetTime: string | undefined,
	windowKind: "weekly" | "session" | "other",
	durationMins: number | undefined,
	shared: boolean,
	accountId: string | undefined,
): UsageLimitLike {
	const remaining = clamp01(remainingFraction);
	const resetsAt = resetTime ? Date.parse(resetTime) : Number.NaN;
	const windowLabel = windowKind === "weekly" ? "Weekly" : windowKind === "session" ? "5 hours" : "Quota";
	return {
		id,
		label,
		scope: {
			provider: PROVIDER_ID,
			accountId,
			windowId: windowKind,
			shared: shared || undefined,
			sharedGroup: shared ? "3p" : undefined,
		},
		window: {
			id: windowKind,
			label: windowLabel,
			durationMs: durationMins ? durationMins * 60_000 : undefined,
			resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
		},
		amount: { usedFraction: 1 - remaining, remainingFraction: remaining, unit: "percent" },
		status: statusFor(remaining),
	};
}

/** Untouched summary buckets report a rolling full-window reset; hide it. */
function summaryResetTime(
	bucket: Record<string, unknown>,
	durationMins: number | undefined,
	requestedAt: number,
): string | undefined {
	const reset = str(bucket.resetTime);
	const untouched =
		bucket.remainingFraction === 1 &&
		bucket.description === undefined &&
		durationMins !== undefined &&
		Math.abs(Date.parse(reset ?? "") - requestedAt - durationMins * 60_000) <= 60_000;
	return untouched ? undefined : reset;
}

/** Parses a `retrieveUserQuotaSummary` response (T3 Code's bucket/group model). */
export function parseQuotaSummary(payload: unknown, requestedAt: number, accountId?: string): UsageLimitLike[] {
	const root = rec(payload);
	if (!root) return [];
	const rawGroups = Array.isArray(root.groups) ? root.groups : [];
	const hasGroupBuckets = rawGroups.some(g => Array.isArray(rec(g)?.buckets) && (rec(g)!.buckets as unknown[]).length > 0);
	const groups: Record<string, unknown>[] = hasGroupBuckets
		? rawGroups.map(g => rec(g) ?? {})
		: [{ buckets: root.buckets }];

	const out = new Map<string, UsageLimitLike>();
	for (const group of groups) {
		const groupName = str(group.displayName)?.trim();
		const buckets = Array.isArray(group.buckets) ? group.buckets : [];
		for (const rawBucket of buckets) {
			const bucket = rec(rawBucket);
			const bucketId = str(bucket?.bucketId);
			if (!bucket || !bucketId || bucket.disabled === true) continue;
			if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) continue;

			const shared = bucketId.startsWith("3p-");
			const family = bucketId.startsWith("gemini-argon-")
				? groupName || "Gemini Argon"
				: bucketId.startsWith("gemini-carbon-")
					? groupName || "Gemini Carbon"
					: bucketId.startsWith("gemini-")
						? "Gemini"
						: shared
							? "Claude & GPT (shared)"
							: groupName || bucketId;
			const windowName = str(bucket.window);
			const kind = windowName === "weekly" ? "weekly" : windowName === "5h" ? "session" : "other";
			const durationMins = SUMMARY_WINDOW_MINS.get(windowName ?? "");
			const kindLabel = kind === "weekly" ? "Weekly" : kind === "session" ? "5-hour" : str(bucket.displayName)?.trim() || "Quota";
			if (out.has(bucketId)) continue;
			out.set(
				bucketId,
				makeLimit(
					bucketId,
					`${family} · ${kindLabel}`,
					bucket.remainingFraction,
					summaryResetTime(bucket, durationMins, requestedAt),
					kind,
					durationMins,
					shared,
					accountId,
				),
			);
		}
	}
	return [...out.values()];
}

/** Parses `fetchAvailableModels` per-model `quotaInfo` / `weeklyQuotaInfo` (older accounts). */
export function parseAvailableModelsQuota(payload: unknown, accountId?: string): UsageLimitLike[] {
	const models = rec(rec(payload)?.models);
	if (!models) return [];
	const out = new Map<string, UsageLimitLike>();
	for (const [modelId, rawModel] of Object.entries(models)) {
		const model = rec(rawModel);
		if (!model) continue;
		const provider = str(model.modelProvider);
		const family =
			provider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
				? "Gemini"
				: provider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
					? "Claude"
					: provider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
						? "GPT"
						: undefined;
		if (!family) continue;
		for (const [suffix, quota] of [
			["quota", rec(model.quotaInfo)],
			["weekly", rec(model.weeklyQuotaInfo)],
		] as const) {
			if (!quota || typeof quota.remainingFraction !== "number" || !Number.isFinite(quota.remainingFraction)) continue;
			const id = `${family.toLowerCase()}-${suffix}`;
			const limit = makeLimit(
				id,
				`${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`,
				quota.remainingFraction,
				str(quota.resetTime),
				suffix === "weekly" ? "weekly" : "other",
				suffix === "weekly" ? 7 * 24 * 60 : undefined,
				family !== "Gemini",
				accountId,
			);
			const prev = out.get(id);
			if (!prev || (limit.amount.usedFraction ?? 0) > (prev.amount.usedFraction ?? 0)) out.set(id, limit);
		}
	}
	return [...out.values()];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AgyUsageProviderOptions {
	readToken?: () => Promise<AgyCliToken | undefined>;
	now?: () => number;
}

export function createAgyUsageProvider(options: AgyUsageProviderOptions = {}) {
	const readToken = options.readToken ?? readAgyCliToken;
	const now = options.now ?? Date.now;

	return {
		id: PROVIDER_ID,

		supports(params: { provider: string }): boolean {
			return params.provider === PROVIDER_ID;
		},

		async fetchUsage(params: UsageFetchParams, context: UsageFetchContext): Promise<UsageReportLike | null> {
			const token = await readToken();
			// The CLI stores no OAuth client, so an expired token can't be refreshed here.
			if (!token || (token.expiresAt !== undefined && token.expiresAt <= now() + 60_000)) return null;

			const authMethod = params.credential.refreshToken === "oauth-business" ? "oauth-business" : "oauth-personal";
			const endpoints = ENDPOINTS[authMethod]!;
			const headers = {
				Authorization: `Bearer ${token.accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": antigravityUserAgent(),
			};
			const body = JSON.stringify(params.credential.projectId ? { project: params.credential.projectId } : {});

			const post = async (endpoint: string, operation: string): Promise<{ at: number; data: unknown } | undefined> => {
				try {
					const at = now();
					const res = await context.fetch(`${endpoint}/v1internal:${operation}`, {
						method: "POST",
						headers,
						body,
						redirect: "manual",
						signal: params.signal,
					});
					if (!res.ok) return undefined;
					return { at, data: await res.json() };
				} catch {
					return undefined;
				}
			};

			let accountId: string | undefined;
			try {
				const res = await context.fetch(USERINFO_URL, {
					headers: { Authorization: `Bearer ${token.accessToken}` },
					redirect: "manual",
					signal: params.signal,
				});
				if (res.ok) accountId = str(rec(await res.json())?.id);
			} catch {
				// account id is optional
			}

			// Merge both hosts; the first (metered) host's reading of a bucket wins.
			const merge = (lists: UsageLimitLike[][]): UsageLimitLike[] => {
				const merged = new Map<string, UsageLimitLike>();
				for (const l of lists.flat()) if (!merged.has(l.id)) merged.set(l.id, l);
				return [...merged.values()];
			};

			const summaries = await Promise.all(endpoints.map(e => post(e, "retrieveUserQuotaSummary")));
			let limits = merge(summaries.map(r => (r ? parseQuotaSummary(r.data, r.at, accountId) : [])));
			let raw: unknown = summaries.map(r => r?.data);

			if (limits.length === 0) {
				const models = await Promise.all(endpoints.map(e => post(e, "fetchAvailableModels")));
				limits = merge(models.map(r => (r ? parseAvailableModelsQuota(r.data, accountId) : [])));
				raw = models.map(r => r?.data);
			}
			if (limits.length === 0) return null;

			return {
				provider: PROVIDER_ID,
				fetchedAt: now(),
				limits,
				metadata: { accountId, authMethod },
				raw,
			};
		},
	};
}

export const agyUsageProvider = createAgyUsageProvider();
