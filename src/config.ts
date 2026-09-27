import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ToolCallItemMode = "mcp_call" | "hidden";

export interface ServerConfig {
	/** Interface to bind. Anything other than a loopback address requires `apiKeys`. */
	host: string;
	port: number;
	/** Accepted bearer tokens. Empty means no authentication. */
	apiKeys: string[];
	/** Allow binding a non-loopback host without `apiKeys`. */
	allowUnauthenticatedRemote: boolean;
	/** Allowed CORS origins. `["*"]` allows any origin; empty disables CORS headers. */
	corsOrigins: string[];
	/** Working directory for agent sessions. Defaults to the directory Pi was started in. */
	cwd?: string;
	/** Allow requests to choose their working directory through `pi_cwd`. */
	allowCwdOverride: boolean;
	/** Store Pi sessions as JSONL files so that they appear in `pi --resume`. */
	persistSessions: boolean;
	/** Session directory. Defaults to Pi's normal per-project session directory. */
	sessionDir?: string;
	/** Directory for stored responses, conversations and uploaded files. */
	dataDir: string;
	/** Pi tools the agent may use. Undefined means Pi's configured defaults. */
	tools?: string[];
	/** How server-side Pi tool calls appear in `output`. */
	toolCallItems: ToolCallItemMode;
	/** Model used when a request asks for `pi`, `default` or an unknown model. Format: `provider/model`. */
	defaultModel?: string;
	/** Request model name → `provider/model`. */
	modelAliases: Record<string, string>;
	/** What to do with a model name that Pi does not know. */
	unknownModel: "default" | "error";
	/** Load the user's other Pi extensions (custom providers, tools, hooks) into API sessions. */
	loadExtensions: boolean;
	/** Expand `/template` and `/skill:` prefixes in user input. */
	expandPromptTemplates: boolean;
	/** How long a response waiting on client function-call output keeps the agent suspended. */
	clientToolTimeoutMs: number;
	/** Idle time after which a pooled session is disposed. */
	sessionIdleTtlMs: number;
	/** Maximum number of responses generated concurrently. */
	maxConcurrentRuns: number;
	/** Maximum accepted request body size. */
	maxBodyBytes: number;
	/** Abort a foreground response when the HTTP client disconnects. */
	abortOnDisconnect: boolean;
	/** Add `x_pi` (session id/file, cost) to response objects. */
	exposeSessionInfo: boolean;
	/** Refresh model catalogs from the network when the server starts. */
	refreshModels: boolean;
	logLevel: "silent" | "info" | "debug";
}

export const DEFAULT_PORT = 8321;

export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function defaultConfigPath(agentDir = defaultAgentDir()): string {
	return process.env.PI_RESPONSES_CONFIG || join(agentDir, "responses-api.json");
}

export function defaultConfig(agentDir = defaultAgentDir()): ServerConfig {
	return {
		host: "127.0.0.1",
		port: DEFAULT_PORT,
		apiKeys: [],
		allowUnauthenticatedRemote: false,
		corsOrigins: [],
		allowCwdOverride: false,
		persistSessions: true,
		dataDir: join(agentDir, "responses-api"),
		toolCallItems: "mcp_call",
		modelAliases: {},
		unknownModel: "default",
		loadExtensions: true,
		expandPromptTemplates: false,
		clientToolTimeoutMs: 10 * 60_000,
		sessionIdleTtlMs: 15 * 60_000,
		maxConcurrentRuns: 4,
		maxBodyBytes: 50 * 1024 * 1024,
		abortOnDisconnect: true,
		exposeSessionInfo: true,
		refreshModels: false,
		logLevel: "info",
	};
}

function splitList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function parseBool(value: string | undefined): boolean | undefined {
	if (value === undefined || value === "") return undefined;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Reads `PI_RESPONSES_*` environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ServerConfig> {
	return stripUndefined({
		host: env.PI_RESPONSES_HOST || undefined,
		port: parseIntOrUndefined(env.PI_RESPONSES_PORT),
		apiKeys: splitList(env.PI_RESPONSES_API_KEYS ?? env.PI_RESPONSES_API_KEY),
		cwd: env.PI_RESPONSES_CWD || undefined,
		tools: splitList(env.PI_RESPONSES_TOOLS),
		defaultModel: env.PI_RESPONSES_DEFAULT_MODEL || undefined,
		dataDir: env.PI_RESPONSES_DATA_DIR || undefined,
		sessionDir: env.PI_RESPONSES_SESSION_DIR || undefined,
		persistSessions: parseBool(env.PI_RESPONSES_PERSIST_SESSIONS),
		loadExtensions: parseBool(env.PI_RESPONSES_LOAD_EXTENSIONS),
		corsOrigins: splitList(env.PI_RESPONSES_CORS_ORIGINS),
		logLevel: (env.PI_RESPONSES_LOG_LEVEL as ServerConfig["logLevel"]) || undefined,
	});
}

export function readConfigFile(path: string): Partial<ServerConfig> {
	if (!existsSync(path)) return {};
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerConfig>;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return raw;
}

/** Merges defaults ← config file ← environment ← explicit overrides and validates the result. */
export function loadConfig(overrides: Partial<ServerConfig> = {}, agentDir = defaultAgentDir()): ServerConfig {
	const merged: ServerConfig = {
		...defaultConfig(agentDir),
		...readConfigFile(defaultConfigPath(agentDir)),
		...configFromEnv(),
		...stripUndefined(overrides),
	};
	merged.dataDir = resolveHome(merged.dataDir);
	if (merged.sessionDir) merged.sessionDir = resolveHome(merged.sessionDir);
	if (merged.cwd) merged.cwd = resolveHome(merged.cwd);
	validateConfig(merged);
	return merged;
}

function resolveHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(path);
}

export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function validateConfig(config: ServerConfig): void {
	if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
		throw new Error(`Invalid port: ${config.port}`);
	}
	if (!isLoopbackHost(config.host) && config.apiKeys.length === 0 && !config.allowUnauthenticatedRemote) {
		throw new Error(
			`Refusing to listen on ${config.host} without an API key. Set PI_RESPONSES_API_KEY (or "apiKeys"), or set "allowUnauthenticatedRemote": true.`,
		);
	}
	if (!["mcp_call", "hidden"].includes(config.toolCallItems)) {
		throw new Error(`toolCallItems must be "mcp_call" or "hidden"`);
	}
	if (!["default", "error"].includes(config.unknownModel)) {
		throw new Error(`unknownModel must be "default" or "error"`);
	}
}

/** Parses `/responses-server start --port 9000 --host 0.0.0.0` style arguments. */
export function parseCommandArgs(args: string): { action: string; overrides: Partial<ServerConfig> } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let action = "status";
	const overrides: Partial<ServerConfig> = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const next = () => {
			const value = tokens[++i];
			if (value === undefined) throw new Error(`Missing value for ${token}`);
			return value;
		};
		if (token === "--port" || token === "-p") overrides.port = Number.parseInt(next(), 10);
		else if (token === "--host") overrides.host = next();
		else if (token === "--api-key") overrides.apiKeys = [next()];
		else if (token === "--cwd") overrides.cwd = next();
		else if (token === "--model") overrides.defaultModel = next();
		else if (token === "--tools") overrides.tools = splitList(next());
		else if (!token.startsWith("-")) action = token;
		else throw new Error(`Unknown option: ${token}`);
	}
	return { action, overrides };
}
