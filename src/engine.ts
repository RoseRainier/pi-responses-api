import { join } from "node:path";
import type { ThinkingLevel } from "./types.ts";
import type { Model } from "@earendil-works/pi-ai";
import { estimateTokens, generateSummaryWithUsage, ModelRegistry, type ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.ts";
import { ApiError, badRequest, errorMessage, notFound } from "./errors.ts";
import { newId, nowSeconds } from "./ids.ts";
import {
	type ConversionContext,
	encodeOpaque,
	type ImagePart,
	isAssistantSideItem,
	itemsToMessages,
	messageText,
	normalizeInput,
	type PiMessage,
	type TargetModel,
	type TextPart,
	type ToolResultMessage,
	type UserMessage,
} from "./input.ts";
import { paginate } from "./pagination.ts";
import { hasOverrides, normalizeToolChoice, type PayloadOverrides } from "./payload.ts";
import { emptyUsage, ResponseRun, synthesizeEvents } from "./run.ts";
import type { ClientToolSpec, SessionHandle, SessionPool } from "./sessions.ts";
import type { SessionPointer, Store, StoredConversation, StoredResponse } from "./store.ts";
import type { CreateResponseParams, Item, Json, ResponseObject, StreamEvent } from "./types.ts";

export const STRUCTURED_TOOL = "structured_output";

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
	none: "off",
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const DEFAULT_MODEL_NAMES = new Set(["", "pi", "default", "pi-default"]);

type Log = (level: "info" | "debug" | "error", message: string) => void;

interface ActiveResponse {
	run: ResponseRun;
	handle?: SessionHandle;
	cancelRequested: boolean;
	/** Wakes the executor when the response is cancelled. */
	wake: () => void;
}

interface Semaphore {
	acquire(): Promise<() => void>;
}

function createSemaphore(limit: number): Semaphore {
	let active = 0;
	const waiting: Array<() => void> = [];
	const release = () => {
		active--;
		waiting.shift()?.();
	};
	return {
		async acquire() {
			if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
			active++;
			return release;
		},
	};
}

/** Everything `create()` validated up front, before anything is streamed. */
interface PreparedRequest {
	params: CreateResponseParams;
	responseId: string;
	store: boolean;
	background: boolean;
	model: Model<Json> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	inputItems: Item[];
	previous?: StoredResponse;
	conversation?: StoredConversation;
	warnings: string[];
}

export class ResponsesEngine {
	private readonly active = new Map<string, ActiveResponse>();
	/** Recently finished runs, kept for `GET ?stream=true` replay. */
	private readonly recent = new Map<string, { run: ResponseRun; expires: number }>();
	/** Responses created with `store: false` whose sessions are still live (suspended on client tools). */
	private readonly unstoredLive = new Map<string, StoredResponse>();
	private readonly conversationQueues = new Map<string, Promise<void>>();
	private readonly semaphore: Semaphore;
	private readonly registry: ModelRegistry;

	constructor(
		private readonly deps: {
			config: ServerConfig;
			store: Store;
			pool: SessionPool;
			modelRuntime: ModelRuntime;
			defaultCwd: string;
			log: Log;
		},
	) {
		this.semaphore = createSemaphore(Math.max(1, deps.config.maxConcurrentRuns));
		this.registry = new ModelRegistry(deps.modelRuntime);
	}

	// =========================================================================
	// Models
	// =========================================================================

	listModels(): Json[] {
		const created = nowSeconds();
		const models = this.deps.modelRuntime.getAvailableSnapshot();
		return [
			{ id: "pi", object: "model", created, owned_by: "pi" },
			...Object.keys(this.deps.config.modelAliases).map((alias) => ({ id: alias, object: "model", created, owned_by: "pi" })),
			...models.map((model) => ({ id: `${model.provider}/${model.id}`, object: "model", created, owned_by: model.provider })),
		];
	}

	getModel(id: string): Json {
		const found = this.listModels().find((model) => model.id === id);
		if (!found) throw notFound(`The model '${id}' does not exist.`, "model");
		return found;
	}

	/** Resolves a request model name. `undefined` means the session's default model. */
	resolveModel(name: string | undefined): Model<Json> | undefined {
		const { config, modelRuntime } = this.deps;
		let requested = (name ?? "").trim();
		requested = config.modelAliases[requested] ?? requested;
		if (DEFAULT_MODEL_NAMES.has(requested)) {
			if (!config.defaultModel) return undefined;
			requested = config.defaultModel;
		}
		const slash = requested.indexOf("/");
		if (slash > 0) {
			const model = modelRuntime.getModel(requested.slice(0, slash), requested.slice(slash + 1));
			if (model) return model as Model<Json>;
		}
		const available = modelRuntime.getAvailableSnapshot();
		const match =
			available.find((model) => model.id === requested) ??
			available.find((model) => model.id.toLowerCase() === requested.toLowerCase()) ??
			modelRuntime.getModels().find((model) => model.id === requested);
		if (match) return match as Model<Json>;
		if (config.unknownModel === "error") {
			throw new ApiError(404, `The model '${name}' does not exist or is not available in Pi.`, { param: "model", code: "model_not_found" });
		}
		if (config.defaultModel && requested !== config.defaultModel) return this.resolveModel(config.defaultModel);
		return undefined;
	}

	// =========================================================================
	// Responses
	// =========================================================================

	/**
	 * Validates and starts a response. Resolves once the response is created; the
	 * returned run finishes asynchronously.
	 */
	async create(params: CreateResponseParams): Promise<ResponseRun> {
		const prepared = this.prepare(params);
		const response = this.skeleton(prepared);
		const handleRef: { handle?: SessionHandle } = {};
		const run = new ResponseRun({
			response,
			classifyTool: (name) => handleRef.handle?.classifyTool(name) ?? "pi",
			toolCallItems: this.deps.config.toolCallItems,
			reasoningMode: params.reasoning?.summary || params.reasoning?.generate_summary ? "summary" : "content",
			includeEncryptedReasoning: Boolean(params.include?.includes("reasoning.encrypted_content")) || prepared.store === false,
			structured: params.text?.format?.type === "json_schema",
		});
		let wake = () => {};
		const wakeSignal = new Promise<void>((resolve) => {
			wake = resolve;
		});
		const active: ActiveResponse = { run, cancelRequested: false, wake };
		this.active.set(response.id, active);
		run.start();

		void (async () => {
			const release = await this.semaphore.acquire();
			try {
				if (active.cancelRequested) {
					run.finish("cancelled");
					if (prepared.store) this.deps.store.saveResponse({ response: run.response, inputItems: prepared.inputItems });
					return;
				}
				run.begin();
				await this.withConversationQueue(prepared.conversation?.id, () => this.execute(prepared, run, active, handleRef, wakeSignal));
			} catch (error) {
				const apiError = error instanceof ApiError ? error : undefined;
				this.deps.log("error", `response ${response.id} failed: ${errorMessage(error)}`);
				run.finish("failed", { error: { code: apiError?.code ?? "server_error", message: errorMessage(error) } });
				if (prepared.store) this.deps.store.saveResponse({ response: run.response, inputItems: prepared.inputItems });
			} finally {
				release();
				this.active.delete(response.id);
				this.recent.set(response.id, { run, expires: Date.now() + 10 * 60_000 });
				this.pruneRecent();
			}
		})();
		return run;
	}

	private prepare(params: CreateResponseParams): PreparedRequest {
		const { store: dataStore } = this.deps;
		if (params.input === undefined && !params.previous_response_id && !params.conversation && !params.prompt) {
			throw badRequest("Missing required parameter: 'input'.", "input");
		}
		const store = params.store !== false;
		const background = params.background === true;
		if (background && !store) throw badRequest("Background responses require 'store' to be true.", "background");
		if (params.previous_response_id && params.conversation) {
			throw badRequest("'previous_response_id' cannot be used together with 'conversation'.", "previous_response_id");
		}
		const warnings: string[] = [];
		let previous: StoredResponse | undefined;
		if (params.previous_response_id) {
			previous = dataStore.getResponse(params.previous_response_id) ?? this.unstoredLive.get(params.previous_response_id);
			if (!previous) throw notFound(`Previous response with id '${params.previous_response_id}' not found.`, "previous_response_id");
			if (this.active.has(params.previous_response_id)) {
				throw badRequest(`Previous response '${params.previous_response_id}' is still in progress.`, "previous_response_id");
			}
		}
		let conversation: StoredConversation | undefined;
		if (params.conversation) {
			const id = typeof params.conversation === "string" ? params.conversation : params.conversation.id;
			conversation = dataStore.getConversation(id);
			if (!conversation) throw notFound(`Conversation with id '${id}' not found.`, "conversation");
		}
		const model = this.resolveModel(params.model);
		const effort = params.reasoning?.effort ?? undefined;
		const thinkingLevel = effort ? THINKING_LEVELS[effort] : undefined;
		if (effort && !thinkingLevel) throw badRequest(`Invalid value for reasoning.effort: '${effort}'.`, "reasoning.effort");
		const inputItems = normalizeInput(params.input, (id) => dataStore.findItem(id));
		const trailing = inputItems.slice(lastAssistantIndex(inputItems) + 1);
		const actionable = trailing.some(
			(item) => (item.type === "message" && item.role === "user") || item.type === "function_call_output" || item.type === "custom_tool_call_output",
		);
		if (!actionable && !params.prompt) {
			throw badRequest("The input must end with a user message or a function call output.", "input");
		}
		if (params.text?.format?.type === "json_schema" && typeof params.text.format.schema !== "object") {
			throw badRequest("text.format.schema is required for json_schema output.", "text.format.schema");
		}
		return {
			params,
			responseId: newId("resp"),
			store,
			background,
			model,
			thinkingLevel,
			inputItems,
			previous,
			conversation,
			warnings,
		};
	}

	private skeleton(prepared: PreparedRequest): ResponseObject {
		const { params } = prepared;
		return {
			id: prepared.responseId,
			object: "response",
			created_at: nowSeconds(),
			completed_at: null,
			status: prepared.background ? "queued" : "in_progress",
			background: prepared.background,
			error: null,
			incomplete_details: null,
			instructions: params.instructions ?? null,
			max_output_tokens: params.max_output_tokens ?? null,
			max_tool_calls: params.max_tool_calls ?? null,
			model: prepared.model ? `${prepared.model.provider}/${prepared.model.id}` : (params.model ?? "pi"),
			output: [],
			parallel_tool_calls: params.parallel_tool_calls ?? true,
			previous_response_id: params.previous_response_id ?? null,
			conversation: prepared.conversation ? { id: prepared.conversation.id } : null,
			prompt: params.prompt ?? null,
			prompt_cache_key: params.prompt_cache_key ?? null,
			reasoning: { effort: params.reasoning?.effort ?? null, summary: params.reasoning?.summary ?? params.reasoning?.generate_summary ?? null },
			safety_identifier: params.safety_identifier ?? null,
			service_tier: "default",
			store: prepared.store,
			temperature: params.temperature ?? null,
			text: { format: params.text?.format ?? { type: "text" }, verbosity: params.text?.verbosity ?? "medium" },
			tool_choice: params.tool_choice ?? "auto",
			tools: params.tools ?? [],
			top_logprobs: params.top_logprobs ?? 0,
			top_p: params.top_p ?? null,
			truncation: params.truncation ?? "disabled",
			usage: null,
			user: params.user ?? null,
			metadata: params.metadata ?? {},
			...(this.deps.config.exposeSessionInfo ? { x_pi: {} } : {}),
		};
	}

	private async withConversationQueue<T>(conversationId: string | undefined, fn: () => Promise<T>): Promise<T> {
		if (!conversationId) return fn();
		const previous = this.conversationQueues.get(conversationId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chained = previous.then(() => current);
		this.conversationQueues.set(conversationId, chained);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.conversationQueues.get(conversationId) === chained) this.conversationQueues.delete(conversationId);
		}
	}

	/** Picks (or creates) the Pi session a request continues from. */
	private async acquireSession(prepared: PreparedRequest): Promise<{ handle: SessionHandle; pointer?: SessionPointer; seedItems: Item[] }> {
		const { pool, config } = this.deps;
		const pointer = prepared.previous?.session ?? prepared.conversation?.session;
		if (pointer) {
			const live = pool.get(pointer.key);
			if (live) return { handle: live, pointer, seedItems: [] };
			if (pointer.file) {
				try {
					return { handle: await pool.openFile(pointer.file, pointer.cwd), pointer, seedItems: [] };
				} catch (error) {
					this.deps.log("info", `session ${pointer.file} could not be reopened (${errorMessage(error)}); rebuilding from stored items`);
				}
			}
		}
		// Fresh session: rebuild history from stored items when continuing.
		let seedItems: Item[] = [];
		if (prepared.previous) seedItems = this.chainItems(prepared.previous);
		else if (prepared.conversation) seedItems = prepared.conversation.items;
		const cwd = this.resolveCwd(prepared.params);
		const firstText = [...seedItems, ...prepared.inputItems].find((item) => item.type === "message" && item.role === "user");
		const handle = await pool.create({
			cwd,
			persist: config.persistSessions && prepared.store,
			ephemeral: !prepared.store,
			model: prepared.model,
			thinkingLevel: prepared.thinkingLevel,
			sessionName: firstText ? `API: ${messageText(firstText).replace(/\s+/g, " ").slice(0, 60)}` : undefined,
		});
		return { handle, seedItems };
	}

	private resolveCwd(params: CreateResponseParams): string {
		const { config, defaultCwd } = this.deps;
		if (params.pi_cwd) {
			if (!config.allowCwdOverride) throw badRequest("'pi_cwd' is disabled on this server (allowCwdOverride).", "pi_cwd");
			return params.pi_cwd;
		}
		return config.cwd ?? defaultCwd;
	}

	/** Items of a response chain in conversation order (for rebuilding a lost session). */
	private chainItems(last: StoredResponse): Item[] {
		const chain: StoredResponse[] = [];
		const seen = new Set<string>();
		let current: StoredResponse | undefined = last;
		while (current && !seen.has(current.response.id)) {
			seen.add(current.response.id);
			chain.unshift(current);
			const previousId: string | null = current.response.previous_response_id;
			if (current.response.conversation) {
				const conversation = this.deps.store.getConversation(current.response.conversation.id);
				if (conversation) {
					const index = conversation.items.findIndex((item) => item.id === current?.inputItems[0]?.id);
					const before = index >= 0 ? conversation.items.slice(0, index) : [];
					return [...before, ...chain.flatMap((record) => [...record.inputItems, ...record.response.output])];
				}
			}
			current = previousId ? (this.deps.store.getResponse(previousId) ?? this.unstoredLive.get(previousId)) : undefined;
		}
		return chain.flatMap((record) => [...record.inputItems, ...record.response.output]);
	}

	private conversionContext(handle: SessionHandle, warnings: string[], callNames?: Map<string, string>): ConversionContext {
		const model = handle.session.model;
		const target: TargetModel = model ? { api: model.api, provider: model.provider, id: model.id } : { api: "unknown", provider: "unknown", id: "unknown" };
		return {
			model: target,
			uploadDir: join(this.deps.config.dataDir, "uploads"),
			callNames: callNames ?? new Map(),
			warn: (message) => warnings.push(message),
		};
	}

	private async execute(
		prepared: PreparedRequest,
		run: ResponseRun,
		active: ActiveResponse,
		handleRef: { handle?: SessionHandle },
		wakeSignal: Promise<void>,
	): Promise<void> {
		const { handle, pointer, seedItems } = await this.acquireSession(prepared);
		handleRef.handle = handle;
		active.handle = handle;

		try {
			await this.runLocked(prepared, run, active, handle, pointer, seedItems, wakeSignal);
		} finally {
			if (!handle.busy) handle.hooks = undefined;
			if (!prepared.store && handle.busy && !handle.suspendedResponseId) await handle.stopActiveRun("Response finished.");
			if (!(handle.ephemeral && handle.busy)) await this.deps.pool.release(handle);
			else {
				// Ephemeral session suspended on client tools: dispose it once the run ends.
				void handle.activePrompt?.finally(() => this.deps.pool.release(handle));
			}
		}
	}

	private async runLocked(
		prepared: PreparedRequest,
		run: ResponseRun,
		active: ActiveResponse,
		handle: SessionHandle,
		pointer: SessionPointer | undefined,
		seedItems: Item[],
		wakeSignal: Promise<void>,
	): Promise<void> {
		const { params, warnings } = prepared;
		const session = handle.session;
		await handle.lock(async () => {
			const isResumingLive =
				handle.busy && handle.suspendedResponseId !== undefined && handle.suspendedResponseId === params.previous_response_id;
			if (handle.busy && !isResumingLive) await handle.stopActiveRun("The conversation continued without the tool output.");
			if (!isResumingLive && pointer) handle.branchTo(pointer.leafId);

			// Model and thinking level.
			if (prepared.model && (session.model?.provider !== prepared.model.provider || session.model?.id !== prepared.model.id)) {
				await session.setModel(prepared.model, { persist: false });
			}
			if (prepared.thinkingLevel && session.thinkingLevel !== prepared.thinkingLevel) {
				session.setThinkingLevel(prepared.thinkingLevel, { persist: false });
			}
			if (session.model) run.response.model = `${session.model.provider}/${session.model.id}`;
			if (run.response.x_pi) {
				run.response.x_pi.session_id = session.sessionId;
				if (session.sessionFile) run.response.x_pi.session_file = session.sessionFile;
			}

			// Known call names for function_call_output conversion.
			const callNames = new Map<string, string>();
			for (const call of prepared.previous?.session?.pendingCalls ?? []) callNames.set(call.call_id, call.name);
			for (const item of prepared.previous?.response.output ?? []) {
				if (item.type === "function_call" || item.type === "custom_tool_call") callNames.set(item.call_id, item.name);
			}
			const ctx = this.conversionContext(handle, warnings, callNames);

			// History that the session has not seen: rebuilt chains and unsynced conversation items.
			const history: Item[] = [...seedItems];
			if (prepared.conversation && pointer) {
				const unsynced = new Set(prepared.conversation.unsyncedItemIds);
				history.push(...prepared.conversation.items.filter((item) => item.id && unsynced.has(item.id)));
			}
			// Input: everything up to the last assistant-side item is history; the rest is new.
			const lastAssistant = lastAssistantIndex(prepared.inputItems);
			// Clients sometimes echo the previous response's calls back; the session already has them.
			const known = new Set<string>();
			if (pointer) {
				for (const item of prepared.previous?.response.output ?? []) {
					if (item.id) known.add(item.id);
					if (item.call_id) known.add(item.call_id);
				}
			}
			history.push(
				...prepared.inputItems
					.slice(0, lastAssistant + 1)
					.filter((item) => !(item.id && known.has(item.id)) && !(item.call_id && isAssistantSideItem(item) && known.has(item.call_id))),
			);
			const freshItems = prepared.inputItems.slice(lastAssistant + 1);

			const converted = await itemsToMessages(history, ctx);
			if (!isResumingLive) handle.appendHistory(converted.messages);
			const fresh = await itemsToMessages(freshItems, ctx);

			const toolResults = fresh.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			const userMessages = fresh.messages.filter((message): message is UserMessage => message.role === "user");
			const others = fresh.messages.filter((message) => message.role !== "toolResult" && message.role !== "user");

			// Per-response configuration.
			const clientTools = this.clientTools(params, warnings);
			const piTools = this.piTools(handle, params, warnings);
			const toolChoice = normalizeToolChoice(params.tool_choice);
			if (toolChoice?.mode === "none") handle.configureTools([], clientTools.filter((tool) => tool.kind === "structured"));
			else handle.configureTools(piTools, clientTools);
			const payload: PayloadOverrides = {
				maxOutputTokens: params.max_output_tokens ?? undefined,
				temperature: params.temperature ?? undefined,
				topP: params.top_p ?? undefined,
				toolChoice,
				parallelToolCalls: params.parallel_tool_calls ?? undefined,
			};
			if (!hasOverrides(payload)) Object.keys(payload).forEach((key) => delete payload[key as keyof PayloadOverrides]);
			handle.hooks = {
				run,
				systemAppend: this.systemAppend(params, [...converted.instructions, ...fresh.instructions], handle),
				payload,
				maxToolCalls: params.max_tool_calls ?? undefined,
				providerRequests: 0,
			};

			// Wire events and client-tool suspension.
			let suspended = false;
			let resolveSuspended!: () => void;
			const suspendedSignal = new Promise<void>((resolve) => {
				resolveSuspended = resolve;
			});
			const runningPiTools = new Set<string>();
			let suspendTimer: NodeJS.Timeout | undefined;
			const checkSuspend = () => {
				if (suspendTimer) clearTimeout(suspendTimer);
				suspendTimer = setTimeout(() => {
					if (!suspended && handle.pending.size > 0 && runningPiTools.size === 0) {
						suspended = true;
						resolveSuspended();
					}
				}, 25);
			};
			const unsubscribe = session.subscribe((event: Json) => {
				if (event.type === "tool_execution_start" && handle.classifyTool(event.toolName) === "pi") runningPiTools.add(event.toolCallId);
				if (event.type === "tool_execution_end") {
					runningPiTools.delete(event.toolCallId);
					checkSuspend();
				}
				run.handleSessionEvent(event);
			});
			handle.onPendingChange = checkSuspend;

			let promptError: unknown;
			try {
				if (isResumingLive) {
					handle.suspendedResponseId = undefined;
					for (const message of userMessages) {
						await session.steer(textOf(message), imagesOf(message));
					}
					for (const result of toolResults) {
						if (!handle.resolvePending(result.toolCallId, result.content, result.isError)) {
							warnings.push(`No pending call with call_id '${result.toolCallId}'.`);
						}
					}
					if (handle.pending.size > 0) handle.rejectAllPending("The client did not provide output for this call.");
				} else {
					const promptMessages = [...toolResults, ...others];
					let start: () => Promise<void>;
					if (promptMessages.length > 0) {
						const all: PiMessage[] = [...promptMessages, ...userMessages];
						start = () => runAgentMessages(session, all);
					} else {
						handle.appendHistory(userMessages.slice(0, -1));
						const last = userMessages.at(-1);
						const text = last ? textOf(last) : "";
						const images = last ? imagesOf(last) : [];
						start = () => session.prompt(text || " ", { images, expandPromptTemplates: this.deps.config.expandPromptTemplates, source: "rpc" });
					}
					handle.suspendedResponseId = undefined;
					handle.activePrompt = start().finally(() => {
						handle.activePrompt = undefined;
					});
				}
				const promptDone = handle.activePrompt?.catch((error) => {
					promptError = error;
				});
				await Promise.race([promptDone ?? Promise.resolve(), suspendedSignal, wakeSignal]);
			} finally {
				if (suspendTimer) clearTimeout(suspendTimer);
				unsubscribe();
				handle.onPendingChange = undefined;
			}

			// Finalize.
			if (active.cancelRequested) {
				await handle.stopActiveRun("Response cancelled.");
				run.finish("cancelled");
			} else if (suspended) {
				handle.suspendedResponseId = run.response.id;
				run.finish("completed");
			} else if (promptError) {
				run.finish("failed", { error: { code: "server_error", message: errorMessage(promptError) } });
			} else {
				const { lastStopReason, lastErrorMessage } = run.totals;
				if (lastStopReason === "error") run.finish("failed", { error: { code: "server_error", message: lastErrorMessage ?? "Model error" } });
				else if (lastStopReason === "aborted") run.finish("cancelled");
				else if (lastStopReason === "length") run.finish("incomplete", { incompleteReason: "max_output_tokens" });
				else run.finish("completed");
			}
			if (warnings.length > 0 && run.response.x_pi) run.response.x_pi.warnings = warnings;

			const sessionPointer: SessionPointer = {
				key: handle.key,
				sessionId: session.sessionId,
				file: session.sessionFile,
				cwd: handle.cwd,
				leafId: session.sessionManager.getLeafId(),
				...(suspended
					? { pendingCalls: [...handle.pending.values()].map((call) => ({ call_id: call.callId, name: call.name, kind: call.kind === "custom" ? ("custom" as const) : ("function" as const) })) }
					: {}),
			};
			const record: StoredResponse = { response: run.response, inputItems: prepared.inputItems, session: sessionPointer };
			if (prepared.store) {
				this.deps.store.saveResponse(record);
				if (prepared.conversation) {
					const conversation = this.deps.store.getConversation(prepared.conversation.id) ?? prepared.conversation;
					conversation.items.push(...prepared.inputItems, ...run.response.output);
					conversation.unsyncedItemIds = [];
					conversation.session = sessionPointer;
					this.deps.store.saveConversation(conversation);
				}
			} else if (suspended) {
				// Allow the client to answer the pending calls via previous_response_id while the session lives.
				this.unstoredLive.set(run.response.id, record);
				const timer = setTimeout(() => this.unstoredLive.delete(run.response.id), this.deps.config.clientToolTimeoutMs);
				timer.unref?.();
			}
		});
	}

	private clientTools(params: CreateResponseParams, warnings: string[]): ClientToolSpec[] {
		const tools: ClientToolSpec[] = [];
		let allowed: Set<string> | undefined;
		if (params.tool_choice?.type === "allowed_tools" && Array.isArray(params.tool_choice.tools)) {
			allowed = new Set(params.tool_choice.tools.map((tool: Json) => tool.name).filter(Boolean));
		}
		for (const tool of params.tools ?? []) {
			if (tool?.type === "function") {
				if (typeof tool.name !== "string" || !tool.name) throw badRequest("Function tools require a 'name'.", "tools");
				if (allowed && !allowed.has(tool.name)) continue;
				tools.push({
					name: tool.name,
					kind: "function",
					description: tool.description ?? "",
					parameters: objectSchema(tool.parameters),
					strict: tool.strict === true,
				});
			} else if (tool?.type === "custom") {
				if (allowed && !allowed.has(tool.name)) continue;
				const format = tool.format?.type === "grammar" ? ` The input must match this ${tool.format.syntax} grammar:\n${tool.format.definition}` : "";
				tools.push({
					name: tool.name,
					kind: "custom",
					description: tool.description ?? "",
					parameters: {
						type: "object",
						properties: { input: { type: "string", description: `Free-form tool input.${format}` } },
						required: ["input"],
					},
					strict: false,
				});
			} else if (tool?.type === "mcp" && tool.server_label === "pi") {
				// Selects Pi tools; handled in piTools().
			} else {
				warnings.push(`Tool type '${tool?.type}' is not supported by this server and was ignored.`);
			}
		}
		const format = params.text?.format;
		if (format?.type === "json_schema") {
			const name = tools.some((tool) => tool.name === STRUCTURED_TOOL) ? `${STRUCTURED_TOOL}_final` : STRUCTURED_TOOL;
			tools.push({
				name,
				kind: "structured",
				description: `Return the final answer as structured data${format.name ? ` (${format.name})` : ""}.${format.description ? ` ${format.description}` : ""}`,
				parameters: objectSchema(format.schema),
				strict: format.strict !== false,
			});
		}
		return tools;
	}

	private piTools(handle: SessionHandle, params: CreateResponseParams, warnings: string[]): string[] {
		const { config } = this.deps;
		const universe = new Set(config.tools ?? handle.allToolNames());
		let selected = config.tools ?? handle.defaultTools;
		const mcp = (params.tools ?? []).find((tool: Json) => tool?.type === "mcp" && tool.server_label === "pi");
		const requested: unknown =
			params.pi_tools ?? (Array.isArray(mcp?.allowed_tools) ? mcp.allowed_tools : mcp?.allowed_tools?.tool_names);
		if (Array.isArray(requested)) {
			selected = requested.filter((name): name is string => typeof name === "string");
			for (const name of selected) if (!universe.has(name)) warnings.push(`Pi tool '${name}' is not available on this server.`);
		}
		return selected.filter((name) => universe.has(name));
	}

	private systemAppend(params: CreateResponseParams, inputInstructions: string[], handle: SessionHandle): string | undefined {
		const parts: string[] = [];
		if (typeof params.instructions === "string" && params.instructions.trim()) parts.push(params.instructions.trim());
		else if (Array.isArray(params.instructions)) {
			const text = params.instructions.map((item: Json) => messageText(item)).filter(Boolean).join("\n\n");
			if (text) parts.push(text);
		}
		parts.push(...inputInstructions);
		if (params.prompt?.id) parts.push(this.expandPromptTemplate(handle, params.prompt));
		const format = params.text?.format;
		if (format?.type === "json_schema") {
			const name = handle.classifyTool(STRUCTURED_TOOL) === "structured" ? STRUCTURED_TOOL : `${STRUCTURED_TOOL}_final`;
			parts.push(
				`When you have the final answer, call the \`${name}\` tool with it as the arguments. Do not write the final answer as plain text; the tool call is the answer.`,
			);
		} else if (format?.type === "json_object") {
			parts.push("Your final answer must be a single valid JSON object and nothing else (no Markdown code fences, no commentary).");
		}
		if (params.text?.verbosity === "low") parts.push("Keep the final answer brief.");
		else if (params.text?.verbosity === "high") parts.push("Give a thorough and detailed final answer.");
		if (params.parallel_tool_calls === false) parts.push("Call at most one tool at a time.");
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}

	/** Expands a Pi prompt template for the Responses `prompt` parameter. */
	private expandPromptTemplate(handle: SessionHandle, prompt: NonNullable<CreateResponseParams["prompt"]>): string {
		const template = handle.session.promptTemplates.find((candidate) => candidate.name === prompt.id);
		if (!template) throw notFound(`Prompt template '${prompt.id}' not found in Pi's prompt templates.`, "prompt.id");
		const variables = prompt.variables ?? {};
		const values = Object.values(variables).map((value) => (typeof value === "string" ? value : messageText({ type: "message", content: [value] })));
		let content = template.content;
		for (const [key, value] of Object.entries(variables)) {
			const text = typeof value === "string" ? value : messageText({ type: "message", content: [value] });
			content = content.replaceAll(`{{${key}}}`, text).replaceAll(`{{ ${key} }}`, text);
		}
		content = content.replaceAll("$ARGUMENTS", values.join(" ")).replaceAll("$@", values.join(" "));
		values.forEach((value, index) => {
			content = content.replaceAll(`$${index + 1}`, value);
		});
		return content;
	}

	/** Returns a running or stored response. */
	get(id: string): ResponseObject {
		const running = this.liveRun(id);
		if (running) return running.response;
		const stored = this.deps.store.getResponse(id);
		if (!stored) throw notFound(`Response with id '${id}' not found.`, "response_id");
		return stored.response;
	}

	/** A running or recently finished run. Responses created with `store: false` are never retrievable. */
	private liveRun(id: string): ResponseRun | undefined {
		const run = this.active.get(id)?.run ?? this.recent.get(id)?.run;
		return run?.response.store ? run : undefined;
	}

	/** Events for `GET /responses/{id}?stream=true`: the live log if available, otherwise synthesized. */
	eventSource(id: string): { events: StreamEvent[]; run?: ResponseRun } {
		const live = this.liveRun(id);
		if (live) return { events: live.events, run: live.isFinished ? undefined : live };
		return { events: synthesizeEvents(this.get(id)) };
	}

	/** Requests cancellation. Returns the response (possibly still settling). */
	async cancel(id: string): Promise<ResponseObject> {
		const active = this.active.get(id);
		if (!active) {
			const response = this.get(id);
			if (response.status === "in_progress" || response.status === "queued") {
				throw badRequest("This response is not running in this server process and cannot be cancelled.", "response_id");
			}
			return response;
		}
		active.cancelRequested = true;
		active.wake();
		if (active.handle) await active.handle.stopActiveRun("Response cancelled.");
		return Promise.race([active.run.finished, new Promise<ResponseObject>((resolve) => setTimeout(() => resolve(active.run.response), 5_000))]);
	}

	/** Aborts a foreground response whose client went away. */
	abandon(id: string): void {
		if (this.active.has(id)) void this.cancel(id).catch(() => {});
	}

	delete(id: string): Json {
		if (this.active.has(id)) throw badRequest("Cannot delete a response that is in progress. Cancel it first.", "response_id");
		this.recent.delete(id);
		if (!this.deps.store.deleteResponse(id)) throw notFound(`Response with id '${id}' not found.`, "response_id");
		return { id, object: "response", deleted: true };
	}

	inputItems(id: string, query: URLSearchParams): Json {
		const stored = this.deps.store.getResponse(id);
		if (!stored) {
			if (this.active.has(id)) throw badRequest("Input items are available once the response has been stored.", "response_id");
			throw notFound(`Response with id '${id}' not found.`, "response_id");
		}
		return paginate(stored.inputItems, query, "desc");
	}

	/** Estimates the input tokens a request would use. */
	async countInputTokens(params: CreateResponseParams): Promise<Json> {
		const items: Item[] = [];
		if (params.previous_response_id) {
			const previous = this.deps.store.getResponse(params.previous_response_id);
			if (!previous) throw notFound(`Previous response with id '${params.previous_response_id}' not found.`, "previous_response_id");
			items.push(...this.chainItems(previous));
		}
		if (params.conversation) {
			const id = typeof params.conversation === "string" ? params.conversation : params.conversation.id;
			const conversation = this.deps.store.getConversation(id);
			if (!conversation) throw notFound(`Conversation with id '${id}' not found.`, "conversation");
			items.push(...conversation.items);
		}
		items.push(...normalizeInput(params.input, (id) => this.deps.store.findItem(id)));
		const model = this.resolveModel(params.model);
		const warnings: string[] = [];
		const converted = await itemsToMessages(items, {
			model: model ? { api: model.api, provider: model.provider, id: model.id } : { api: "unknown", provider: "unknown", id: "unknown" },
			uploadDir: join(this.deps.config.dataDir, "uploads"),
			callNames: new Map(),
			warn: (message) => warnings.push(message),
		});
		let tokens = converted.messages.reduce((sum, message) => sum + estimateTokens(message as Json), 0);
		const extraChars =
			(typeof params.instructions === "string" ? params.instructions.length : 0) +
			converted.instructions.join("").length +
			JSON.stringify(params.tools ?? []).length;
		tokens += Math.ceil(extraChars / 4);
		return { object: "response.input_tokens", input_tokens: tokens };
	}

	/** `POST /responses/compact`: summarizes a conversation into a single opaque compaction item. */
	async compact(params: CreateResponseParams): Promise<Json> {
		const items: Item[] = [];
		if (params.previous_response_id) {
			const previous = this.deps.store.getResponse(params.previous_response_id);
			if (!previous) throw notFound(`Previous response with id '${params.previous_response_id}' not found.`, "previous_response_id");
			items.push(...this.chainItems(previous));
		}
		items.push(...normalizeInput(params.input, (id) => this.deps.store.findItem(id)));
		if (items.length === 0) throw badRequest("Nothing to compact: provide 'input' or 'previous_response_id'.", "input");
		const model = this.resolveModel(params.model) ?? this.defaultModel();
		if (!model) throw badRequest("No model is available for compaction.", "model");
		const warnings: string[] = [];
		const converted = await itemsToMessages(items, {
			model: { api: model.api, provider: model.provider, id: model.id },
			uploadDir: join(this.deps.config.dataDir, "uploads"),
			callNames: new Map(),
			warn: (message) => warnings.push(message),
		});
		const custom = [typeof params.instructions === "string" ? params.instructions : "", ...converted.instructions].filter(Boolean).join("\n\n");
		const registry = this.registry;
		const result = await generateSummaryWithUsage(
			converted.messages as Json,
			model,
			16_384,
			undefined,
			undefined,
			undefined,
			custom || undefined,
			undefined,
			undefined,
			((m: Json, context: Json, options: Json) => registry.streamSimple(m, context, options)) as Json,
		);
		const usage = emptyUsage();
		usage.input_tokens = (result.usage.input ?? 0) + (result.usage.cacheRead ?? 0) + (result.usage.cacheWrite ?? 0);
		usage.input_tokens_details.cached_tokens = result.usage.cacheRead ?? 0;
		usage.output_tokens = result.usage.output ?? 0;
		usage.total_tokens = usage.input_tokens + usage.output_tokens;
		return {
			id: newId("resp"),
			object: "response.compaction",
			created_at: nowSeconds(),
			output: [{ id: newId("cmp"), type: "compaction", encrypted_content: encodeOpaque({ v: 1, summary: result.text }), created_by: "pi" }],
			usage,
		};
	}

	/** The model Pi would pick for a new session: settings default, else the first available model. */
	private defaultModel(): Model<Json> | undefined {
		const settings = SettingsManager.create(this.deps.config.cwd ?? this.deps.defaultCwd);
		const provider = settings.getDefaultProvider();
		const id = settings.getDefaultModel();
		const configured = provider && id ? this.deps.modelRuntime.getModel(provider, id) : undefined;
		return (configured ?? this.deps.modelRuntime.getAvailableSnapshot()[0]) as Model<Json> | undefined;
	}

	// =========================================================================
	// Conversations
	// =========================================================================

	createConversation(body: Json): Json {
		const items = normalizeInput(body?.items ?? [], (id) => this.deps.store.findItem(id));
		const conversation: StoredConversation = {
			id: newId("conv"),
			object: "conversation",
			created_at: nowSeconds(),
			metadata: body?.metadata ?? {},
			items,
			unsyncedItemIds: items.map((item) => item.id as string),
		};
		this.deps.store.saveConversation(conversation);
		return conversationView(conversation);
	}

	getConversation(id: string): Json {
		return conversationView(this.requireConversation(id));
	}

	updateConversation(id: string, body: Json): Json {
		const conversation = this.requireConversation(id);
		conversation.metadata = body?.metadata ?? {};
		this.deps.store.saveConversation(conversation);
		return conversationView(conversation);
	}

	deleteConversation(id: string): Json {
		if (!this.deps.store.deleteConversation(id)) throw notFound(`Conversation with id '${id}' not found.`, "conversation_id");
		return { id, object: "conversation.deleted", deleted: true };
	}

	addConversationItems(id: string, body: Json): Json {
		const conversation = this.requireConversation(id);
		if (!Array.isArray(body?.items)) throw badRequest("'items' must be an array.", "items");
		const items = normalizeInput(body.items, (itemId) => this.deps.store.findItem(itemId));
		conversation.items.push(...items);
		conversation.unsyncedItemIds.push(...items.map((item) => item.id as string));
		this.deps.store.saveConversation(conversation);
		return { object: "list", data: items, first_id: items[0]?.id ?? null, last_id: items.at(-1)?.id ?? null, has_more: false };
	}

	listConversationItems(id: string, query: URLSearchParams): Json {
		return paginate(this.requireConversation(id).items, query, "desc");
	}

	getConversationItem(id: string, itemId: string): Json {
		const item = this.requireConversation(id).items.find((candidate) => candidate.id === itemId);
		if (!item) throw notFound(`Item with id '${itemId}' not found.`, "item_id");
		return item;
	}

	deleteConversationItem(id: string, itemId: string): Json {
		const conversation = this.requireConversation(id);
		const index = conversation.items.findIndex((candidate) => candidate.id === itemId);
		if (index < 0) throw notFound(`Item with id '${itemId}' not found.`, "item_id");
		conversation.items.splice(index, 1);
		conversation.unsyncedItemIds = conversation.unsyncedItemIds.filter((candidate) => candidate !== itemId);
		this.deps.store.saveConversation(conversation);
		return conversationView(conversation);
	}

	private requireConversation(id: string): StoredConversation {
		const conversation = this.deps.store.getConversation(id);
		if (!conversation) throw notFound(`Conversation with id '${id}' not found.`, "conversation_id");
		return conversation;
	}

	// =========================================================================

	get activeCount(): number {
		return this.active.size;
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.active.keys()].map((id) => this.cancel(id).catch(() => {})));
	}

	private pruneRecent(): void {
		const now = Date.now();
		for (const [id, entry] of this.recent) if (entry.expires < now) this.recent.delete(id);
	}
}

function lastAssistantIndex(items: Item[]): number {
	let last = -1;
	items.forEach((item, index) => {
		if (isAssistantSideItem(item)) last = index;
	});
	return last;
}

function conversationView(conversation: StoredConversation): Json {
	return { id: conversation.id, object: "conversation", created_at: conversation.created_at, metadata: conversation.metadata };
}

function objectSchema(schema: Json): Json {
	if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
	if (schema.type === "object" || schema.properties) return { type: "object", ...schema };
	return { type: "object", properties: { value: schema }, required: ["value"] };
}

function textOf(message: UserMessage): string {
	return message.content
		.filter((part): part is TextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n\n");
}

function imagesOf(message: UserMessage): ImagePart[] {
	return message.content.filter((part): part is ImagePart => part.type === "image");
}

/**
 * Runs the agent on prepared messages (tool results plus optional user messages).
 * `AgentSession.prompt()` only accepts a user text, so this uses the internal entry point
 * that `prompt()` itself delegates to, falling back to a hidden continuation message.
 */
async function runAgentMessages(session: SessionHandle["session"], messages: PiMessage[]): Promise<void> {
	const internal = session as unknown as { _runAgentPrompt?: (messages: PiMessage[]) => Promise<void> };
	if (typeof internal._runAgentPrompt === "function") {
		await internal._runAgentPrompt(messages);
		return;
	}
	for (const message of messages) session.sessionManager.appendMessage(message as Json);
	session.refreshContext();
	await session.sendCustomMessage(
		{ customType: "responses-api-continue", content: "Continue.", display: false },
		{ triggerTurn: true },
	);
}
