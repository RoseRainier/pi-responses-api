import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "./types.ts";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ServerConfig } from "./config.ts";
import { newId } from "./ids.ts";
import type { ImagePart, PiMessage, TextPart } from "./input.ts";
import { type PayloadOverrides, patchPayload } from "./payload.ts";
import type { ResponseRun, ToolKind } from "./run.ts";
import type { Json } from "./types.ts";

/** This package's root, so that API sessions do not load this extension recursively. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ClientToolKind = Exclude<ToolKind, "pi">;

/** A client-side tool declared by the current request. */
export interface ClientToolSpec {
	name: string;
	kind: ClientToolKind;
	description: string;
	parameters: Json;
	strict: boolean;
}

/** Per-response state consulted by the bridge extension while the agent runs. */
export interface RunHooks {
	run: ResponseRun;
	/** Text appended to the system prompt for this response only. */
	systemAppend?: string;
	payload: PayloadOverrides;
	maxToolCalls?: number;
	providerRequests: number;
}

interface PendingCall {
	callId: string;
	name: string;
	kind: ClientToolKind;
	resolve: (content: (TextPart | ImagePart)[]) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

type Log = (level: "info" | "debug" | "error", message: string) => void;

/**
 * One live Pi `AgentSession` plus the state needed to run Responses API requests on it.
 */
export class SessionHandle {
	readonly key: string;
	readonly session: AgentSession;
	readonly cwd: string;
	readonly ephemeral: boolean;
	/** Pi tools active by default in this session (before client tools were added). */
	readonly defaultTools: string[];
	hooks: RunHooks | undefined;
	/** The unfinished `prompt()` of a suspended or running agent run. */
	activePrompt: Promise<void> | undefined;
	/** Response id that is waiting for client function-call output. */
	suspendedResponseId: string | undefined;
	lastUsed = Date.now();
	onPendingChange: (() => void) | undefined;
	readonly pending = new Map<string, PendingCall>();
	private readonly api: ExtensionAPI;
	private readonly clientToolSignatures = new Map<string, string>();
	private currentClientTools = new Map<string, ClientToolSpec>();
	private queue: Promise<void> = Promise.resolve();
	private readonly config: ServerConfig;

	constructor(init: { key: string; session: AgentSession; api: ExtensionAPI; cwd: string; ephemeral: boolean; config: ServerConfig }) {
		this.key = init.key;
		this.session = init.session;
		this.api = init.api;
		this.cwd = init.cwd;
		this.ephemeral = init.ephemeral;
		this.config = init.config;
		this.defaultTools = init.session.getActiveToolNames();
	}

	/** Serializes work on this session. */
	async lock<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	get busy(): boolean {
		return this.activePrompt !== undefined;
	}

	/** All tool names registered in the session. */
	allToolNames(): string[] {
		return this.session.getAllTools().map((tool) => tool.name);
	}

	classifyTool(name: string): ToolKind {
		return this.currentClientTools.get(name)?.kind ?? "pi";
	}

	/** Registers the client tools of this request and activates them together with `piTools`. */
	configureTools(piTools: string[], clientTools: ClientToolSpec[]): void {
		this.currentClientTools = new Map(clientTools.map((tool) => [tool.name, tool]));
		for (const tool of clientTools) {
			const signature = JSON.stringify(tool);
			if (this.clientToolSignatures.get(tool.name) === signature) continue;
			this.clientToolSignatures.set(tool.name, signature);
			this.api.registerTool({
				name: tool.name,
				label: tool.name,
				description: tool.description,
				parameters: Type.Unsafe(tool.parameters),
				...(tool.strict ? { constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const } } : {}),
				execute: (toolCallId, params, signal) => this.executeClientTool(toolCallId, tool.name, params, signal),
			});
		}
		const clientNames = new Set(clientTools.map((tool) => tool.name));
		this.session.setActiveToolsByName([...piTools.filter((name) => !clientNames.has(name)), ...clientNames]);
	}

	private async executeClientTool(toolCallId: string, name: string, params: Json, signal: AbortSignal | undefined) {
		const spec = this.currentClientTools.get(name);
		if (spec?.kind === "structured") {
			return { content: [{ type: "text" as const, text: "Structured output recorded." }], details: undefined, terminate: true };
		}
		if (!spec) throw new Error(`Tool ${name} is not available in this request.`);
		const content = await new Promise<(TextPart | ImagePart)[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(toolCallId);
				reject(new Error(`The client did not return output for ${name} within ${this.config.clientToolTimeoutMs} ms.`));
				// Nobody can resume an ephemeral session later; stop instead of spending tokens on a continuation.
				if (this.ephemeral) void this.stopActiveRun("Client tool output timed out.");
			}, this.config.clientToolTimeoutMs);
			timer.unref?.();
			this.pending.set(toolCallId, { callId: toolCallId, name, kind: spec.kind, resolve, reject, timer });
			signal?.addEventListener(
				"abort",
				() => {
					if (!this.pending.has(toolCallId)) return;
					clearTimeout(timer);
					this.pending.delete(toolCallId);
					reject(new Error("Aborted"));
				},
				{ once: true },
			);
			this.onPendingChange?.();
		});
		return { content, details: { params } };
	}

	/** Delivers client output for a pending call. Returns false if the call is not pending. */
	resolvePending(callId: string, content: (TextPart | ImagePart)[], isError = false): boolean {
		const pending = this.pending.get(callId);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pending.delete(callId);
		if (isError) pending.reject(new Error(content.map((part) => (part.type === "text" ? part.text : "")).join("\n")));
		else pending.resolve(content);
		return true;
	}

	/** Fails every pending client call, e.g. when the conversation moves on without the outputs. */
	rejectAllPending(reason: string): void {
		for (const pending of [...this.pending.values()]) {
			clearTimeout(pending.timer);
			this.pending.delete(pending.callId);
			pending.reject(new Error(reason));
		}
	}

	/** Stops a suspended or running agent run. */
	async stopActiveRun(reason: string): Promise<void> {
		this.rejectAllPending(reason);
		const prompt = this.activePrompt;
		if (prompt) {
			await this.session.abort().catch(() => {});
			await prompt.catch(() => {});
		}
		this.suspendedResponseId = undefined;
	}

	/** Moves the session to `leafId` if it is not already there. */
	branchTo(leafId: string | null): void {
		const manager = this.session.sessionManager;
		if (manager.getLeafId() === leafId) return;
		if (leafId === null) manager.resetLeaf();
		else manager.branch(leafId);
		this.session.refreshContext();
	}

	/** Appends history messages (e.g. items added through the Conversations API) to the transcript. */
	appendHistory(messages: PiMessage[]): void {
		if (messages.length === 0) return;
		for (const message of messages) this.session.sessionManager.appendMessage(message as Json);
		this.session.refreshContext();
	}

	/** Installs the bridge handlers. Called from the inline extension factory. */
	static installBridge(pi: ExtensionAPI, getHandle: () => SessionHandle | undefined): void {
		pi.on("context_with_system", (event) => {
			const append = getHandle()?.hooks?.systemAppend;
			const [first, ...rest] = event.messages as Json[];
			if (!append || first?.role !== "system") return;
			const system = { ...first };
			if (system.sections && Object.keys(system.sections).length > 0) {
				system.sections = { ...system.sections, responses_api: `<responses_api>\n${append}\n</responses_api>` };
			} else if (typeof system.content === "string") {
				system.content = system.content ? `${system.content}\n\n${append}` : append;
			} else {
				system.content = [...(system.content ?? []), { type: "text", text: append }];
			}
			return { messages: [system, ...rest] };
		});

		pi.on("before_provider_request", (event, ctx) => {
			const hooks = getHandle()?.hooks;
			if (!hooks) return;
			const first = hooks.providerRequests === 0;
			hooks.providerRequests++;
			const overrides: PayloadOverrides = { ...hooks.payload };
			// Forcing a tool on every turn would never let the agent finish.
			if (!first && overrides.toolChoice && overrides.toolChoice.mode !== "none") overrides.toolChoice = undefined;
			const api = ctx.model?.api;
			if (!api) return;
			const patched = patchPayload(api, event.payload, overrides);
			return patched === event.payload ? undefined : patched;
		});

		pi.on("tool_call", (event) => {
			const handle = getHandle();
			const hooks = handle?.hooks;
			if (!handle || !hooks || handle.classifyTool(event.toolName) !== "pi") return;
			const count = hooks.run.countToolCall();
			if (hooks.maxToolCalls !== undefined && count > hooks.maxToolCalls) {
				return { block: true, reason: `The limit of ${hooks.maxToolCalls} tool calls for this response has been reached.` };
			}
		});
	}
}

export interface OpenSessionOptions {
	cwd: string;
	/** Existing session file to open. */
	file?: string;
	/** Create a persisted session (true) or an in-memory one (false). */
	persist: boolean;
	/** Dispose the session once the response is finished. */
	ephemeral: boolean;
	model?: Model<Json>;
	thinkingLevel?: ThinkingLevel;
	sessionName?: string;
}

interface SessionPoolDependencies {
	config: ServerConfig;
	/** Return a fresh runtime: extension provider registrations belong to one session. */
	createModelRuntime: () => Promise<ModelRuntime>;
	agentDir: string;
	log: Log;
}

/** Keeps live sessions keyed by session file (or in-memory id) and disposes idle ones. */
export class SessionPool {
	private readonly handles = new Map<string, SessionHandle>();
	private readonly opening = new Map<string, Promise<SessionHandle>>();
	private sweepTimer: NodeJS.Timeout | undefined;
	private readonly deps: SessionPoolDependencies;

	constructor(deps: SessionPoolDependencies) {
		this.deps = deps;
		this.sweepTimer = setInterval(() => void this.sweep(), 30_000);
		this.sweepTimer.unref?.();
	}

	get size(): number {
		return this.handles.size;
	}

	get(key: string): SessionHandle | undefined {
		return this.handles.get(key);
	}

	/** Returns the pooled handle for `file`, opening the session if needed. */
	async openFile(file: string, cwd: string): Promise<SessionHandle> {
		const existing = this.handles.get(file);
		if (existing) return existing;
		const inFlight = this.opening.get(file);
		if (inFlight) return inFlight;
		const promise = this.create({ cwd, file, persist: true, ephemeral: false }).finally(() => this.opening.delete(file));
		this.opening.set(file, promise);
		return promise;
	}

	async create(options: OpenSessionOptions): Promise<SessionHandle> {
		const { config, createModelRuntime, agentDir, log } = this.deps;
		// Extensions may replace/wrap providers during session_start and restore them
		// on shutdown. Sharing a runtime would stack wrappers across conversations.
		const modelRuntime = await createModelRuntime();
		const sessionManager = options.file
			? SessionManager.open(options.file, config.sessionDir, options.cwd)
			: options.persist
				? SessionManager.create(options.cwd, config.sessionDir)
				: SessionManager.inMemory(options.cwd);

		let handle: SessionHandle | undefined;
		let bridgeApi: ExtensionAPI | undefined;
		const loader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir,
			noExtensions: !config.loadExtensions,
			extensionFactories: [
				{
					name: "responses-api-bridge",
					hidden: true,
					factory: (pi) => {
						bridgeApi = pi;
						SessionHandle.installBridge(pi, () => handle);
					},
				},
			],
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter((extension) => !isOwnExtension(extension.resolvedPath || extension.path)),
			}),
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: options.cwd,
			agentDir,
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
			...(options.model ? { model: options.model } : {}),
			...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		});
		await session.bindExtensions({
			onError: (error) => log("error", `extension ${error.extensionPath}: ${error.error}`),
		});
		if (!bridgeApi) throw new Error("Bridge extension was not initialized");
		if (options.sessionName && sessionManager.isPersisted()) session.setSessionName(options.sessionName);

		const key = sessionManager.getSessionFile() ?? `mem:${newId("sess")}`;
		handle = new SessionHandle({ key, session, api: bridgeApi, cwd: options.cwd, ephemeral: options.ephemeral, config });
		if (!options.ephemeral) this.handles.set(key, handle);
		log("debug", `opened session ${key}`);
		return handle;
	}

	/** Marks a handle idle; ephemeral handles are disposed immediately. */
	async release(handle: SessionHandle): Promise<void> {
		handle.lastUsed = Date.now();
		if (handle.ephemeral && !handle.busy) await this.dispose(handle);
	}

	async dispose(handle: SessionHandle): Promise<void> {
		this.handles.delete(handle.key);
		await handle.stopActiveRun("Session closed").catch(() => {});
		const runner = handle.session.extensionRunner;
		try {
			if (runner.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" } as Json);
		} catch (error) {
			this.deps.log("error", `session_shutdown failed: ${String(error)}`);
		}
		handle.session.dispose();
		this.deps.log("debug", `closed session ${handle.key}`);
	}

	private async sweep(): Promise<void> {
		const cutoff = Date.now() - this.deps.config.sessionIdleTtlMs;
		for (const handle of [...this.handles.values()]) {
			if (!handle.busy && handle.lastUsed < cutoff) await this.dispose(handle);
		}
	}

	async disposeAll(): Promise<void> {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		await Promise.all([...this.handles.values()].map((handle) => this.dispose(handle)));
	}
}

const PACKAGE_NAME = "pi-responses-api";
const ownPackageCache = new Map<string, boolean>();

/** True for this package, including other installed copies of it (git/npm/local). */
function isOwnExtension(path: string | undefined): boolean {
	if (!path) return false;
	const resolved = resolve(path);
	if (resolved === PACKAGE_ROOT || resolved.startsWith(PACKAGE_ROOT + sep)) return true;
	let dir = dirname(resolved);
	for (let depth = 0; depth < 4; depth++) {
		const cached = ownPackageCache.get(dir);
		if (cached !== undefined) return cached;
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			let own = false;
			try {
				own = JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME;
			} catch {
				own = false;
			}
			ownPackageCache.set(dir, own);
			return own;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return false;
}
