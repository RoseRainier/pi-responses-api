import type { ToolCallItemMode } from "./config.ts";
import { newId, nowSeconds } from "./ids.ts";
import { encodeOpaque, type ReasoningPayload } from "./input.ts";
import type { Item, Json, ResponseObject, ResponseStatus, ResponseUsage, StreamEvent } from "./types.ts";

/** How a tool call from the model is surfaced in `output`. */
export type ToolKind = "pi" | "function" | "custom" | "structured";

export interface RunOptions {
	response: ResponseObject;
	classifyTool: (name: string) => ToolKind;
	toolCallItems: ToolCallItemMode;
	/** Put model thinking into `summary` (when the request asked for a summary) or `content`. */
	reasoningMode: "summary" | "content";
	includeEncryptedReasoning: boolean;
	/** Structured output mode: plain text is held back and only emitted if no structured result arrives. */
	structured: boolean;
}

interface OpenMessage {
	item: Item;
	outputIndex: number;
}

type Block =
	| { kind: "text"; message: OpenMessage; partIndex: number }
	| { kind: "buffered"; text: string }
	| { kind: "thinking"; item: Item; outputIndex: number }
	| { kind: "tool"; toolKind: ToolKind; item?: Item; outputIndex: number; message?: OpenMessage; partIndex?: number; started: boolean };

export interface RunTotals {
	usage: ResponseUsage;
	costUsd: number;
	lastStopReason?: string;
	lastErrorMessage?: string;
	toolCallCount: number;
}

type Listener = (event: StreamEvent) => void;

/**
 * Builds one Responses API response from Pi agent events and emits the matching
 * streaming events. The run owns the response object; callers only feed events
 * and decide when the response finishes.
 */
export class ResponseRun {
	readonly response: ResponseObject;
	readonly events: StreamEvent[] = [];
	readonly totals: RunTotals = {
		usage: emptyUsage(),
		costUsd: 0,
		toolCallCount: 0,
	};
	private readonly options: RunOptions;
	private readonly listeners = new Set<Listener>();
	private sequence = 0;
	private blocks = new Map<number, Block>();
	private openMessage: OpenMessage | undefined;
	private turnSawStreamEvents = false;
	private readonly toolItems = new Map<string, { item: Item; outputIndex: number }>();
	private readonly bufferedTexts: string[] = [];
	private structuredEmitted = false;
	private finishedFlag = false;
	private resolveFinished!: (response: ResponseObject) => void;
	readonly finished: Promise<ResponseObject>;

	constructor(options: RunOptions) {
		this.options = options;
		this.response = options.response;
		this.finished = new Promise((resolve) => {
			this.resolveFinished = resolve;
		});
	}

	get isFinished(): boolean {
		return this.finishedFlag;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(type: string, data: Record<string, Json> = {}): void {
		const event: StreamEvent = { type, sequence_number: this.sequence++, ...structuredClone(data) };
		this.events.push(event);
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A broken listener (closed socket) must not break the run.
			}
		}
	}

	private addItem(item: Item): number {
		const outputIndex = this.response.output.length;
		this.response.output.push(item);
		this.emit("response.output_item.added", { output_index: outputIndex, item });
		return outputIndex;
	}

	private doneItem(item: Item, outputIndex: number): void {
		this.emit("response.output_item.done", { output_index: outputIndex, item });
	}

	// ---- lifecycle ----

	/** Emits `response.created` (and `response.queued` for queued background responses). */
	start(): void {
		this.emit("response.created", { response: this.response });
		if (this.response.status === "queued") this.emit("response.queued", { response: this.response });
		else this.emit("response.in_progress", { response: this.response });
	}

	/** Moves a queued response to `in_progress`. */
	begin(): void {
		if (this.response.status !== "queued") return;
		this.response.status = "in_progress";
		this.emit("response.in_progress", { response: this.response });
	}

	/** Finalizes the response and emits the terminal event. Idempotent. */
	finish(status: ResponseStatus, details: { error?: { code: string; message: string }; incompleteReason?: string } = {}): ResponseObject {
		if (this.finishedFlag) return this.response;
		this.finishedFlag = true;
		this.closeMessage();
		for (const block of this.blocks.values()) this.abandonBlock(block);
		this.blocks.clear();
		for (const { item, outputIndex } of this.toolItems.values()) {
			item.status = "incomplete";
			this.doneItem(item, outputIndex);
		}
		this.toolItems.clear();
		if (this.options.structured && !this.structuredEmitted) {
			for (const text of this.bufferedTexts) this.emitWholeMessage(text);
		}
		this.bufferedTexts.length = 0;

		const response = this.response;
		response.status = status;
		response.completed_at = status === "completed" ? nowSeconds() : null;
		response.usage = this.totals.usage;
		response.error = details.error ?? null;
		response.incomplete_details = details.incompleteReason ? { reason: details.incompleteReason } : null;
		if (response.x_pi) response.x_pi.cost_usd = Number(this.totals.costUsd.toFixed(6));

		const eventType =
			status === "completed"
				? "response.completed"
				: status === "incomplete"
					? "response.incomplete"
					: status === "cancelled"
						? "response.cancelled"
						: "response.failed";
		this.emit(eventType, { response });
		this.resolveFinished(response);
		this.listeners.clear();
		return response;
	}

	// ---- Pi events ----

	/** Feeds one `AgentSession` event. */
	handleSessionEvent(event: Json): void {
		if (this.finishedFlag) return;
		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					this.blocks = new Map();
					this.turnSawStreamEvents = false;
				}
				break;
			case "message_update":
				this.turnSawStreamEvents = true;
				this.handleAssistantEvent(event.assistantMessageEvent);
				break;
			case "message_end":
				if (event.message?.role === "assistant") this.handleAssistantEnd(event.message);
				break;
			case "tool_execution_end":
				this.handleToolExecutionEnd(event.toolCallId, event.result, event.isError);
				break;
		}
	}

	private handleAssistantEvent(e: Json): void {
		switch (e.type) {
			case "text_start":
				this.textStart(e.contentIndex);
				break;
			case "text_delta":
				this.textDelta(e.contentIndex, e.delta);
				break;
			case "text_end":
				this.textEnd(e.contentIndex, e.content);
				break;
			case "thinking_start":
				this.thinkingStart(e.contentIndex);
				break;
			case "thinking_delta":
				this.thinkingDelta(e.contentIndex, e.delta);
				break;
			case "thinking_end":
				this.thinkingEnd(e.contentIndex, e.content, e.partial?.content?.[e.contentIndex]);
				break;
			case "toolcall_start":
				this.toolStart(e.contentIndex, e.partial?.content?.[e.contentIndex]);
				break;
			case "toolcall_delta":
				this.toolDelta(e.contentIndex, e.delta, e.partial?.content?.[e.contentIndex]);
				break;
			case "toolcall_end":
				this.toolEnd(e.contentIndex, e.toolCall);
				break;
			case "done":
			case "error":
				this.closeMessage();
				break;
		}
	}

	private handleAssistantEnd(message: Json): void {
		if (!this.turnSawStreamEvents) this.replayMessage(message);
		this.closeMessage();
		for (const block of this.blocks.values()) this.abandonBlock(block);
		this.blocks = new Map();
		this.addUsage(message.usage);
		this.totals.lastStopReason = message.stopReason;
		this.totals.lastErrorMessage = message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage : undefined;
	}

	/** Produces the item events for an assistant message that arrived without streaming updates. */
	private replayMessage(message: Json): void {
		const content: Json[] = Array.isArray(message.content) ? message.content : [];
		content.forEach((part, index) => {
			if (part.type === "text") {
				this.textStart(index);
				this.textDelta(index, part.text);
				this.textEnd(index, part.text);
			} else if (part.type === "thinking") {
				this.thinkingStart(index);
				this.thinkingDelta(index, part.thinking);
				this.thinkingEnd(index, part.thinking, part);
			} else if (part.type === "toolCall") {
				this.toolStart(index, part);
				this.toolEnd(index, part);
			}
		});
	}

	private addUsage(usage: Json): void {
		if (!usage) return;
		const total = this.totals.usage;
		const cached = usage.cacheRead ?? 0;
		const input = (usage.input ?? 0) + cached + (usage.cacheWrite ?? 0);
		total.input_tokens += input;
		total.input_tokens_details.cached_tokens += cached;
		total.output_tokens += usage.output ?? 0;
		total.output_tokens_details.reasoning_tokens += usage.reasoning ?? 0;
		total.total_tokens = total.input_tokens + total.output_tokens;
		this.totals.costUsd += usage.cost?.total ?? 0;
	}

	// ---- text ----

	private ensureMessage(): OpenMessage {
		if (this.openMessage) return this.openMessage;
		const item: Item = { id: newId("msg"), type: "message", status: "in_progress", role: "assistant", content: [] };
		const outputIndex = this.addItem(item);
		this.openMessage = { item, outputIndex };
		return this.openMessage;
	}

	private closeMessage(): void {
		const open = this.openMessage;
		if (!open) return;
		this.openMessage = undefined;
		open.item.status = "completed";
		this.doneItem(open.item, open.outputIndex);
	}

	private startTextPart(message: OpenMessage): number {
		const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
		const partIndex = message.item.content.length;
		message.item.content.push(part);
		this.emit("response.content_part.added", {
			item_id: message.item.id,
			output_index: message.outputIndex,
			content_index: partIndex,
			part,
		});
		return partIndex;
	}

	private appendText(message: OpenMessage, partIndex: number, delta: string): void {
		if (!delta) return;
		message.item.content[partIndex].text += delta;
		this.emit("response.output_text.delta", {
			item_id: message.item.id,
			output_index: message.outputIndex,
			content_index: partIndex,
			delta,
			logprobs: [],
		});
	}

	private endTextPart(message: OpenMessage, partIndex: number, text: string): void {
		const part = message.item.content[partIndex];
		part.text = text;
		this.emit("response.output_text.done", {
			item_id: message.item.id,
			output_index: message.outputIndex,
			content_index: partIndex,
			text,
			logprobs: [],
		});
		this.emit("response.content_part.done", {
			item_id: message.item.id,
			output_index: message.outputIndex,
			content_index: partIndex,
			part,
		});
	}

	private emitWholeMessage(text: string): void {
		const message = this.ensureMessage();
		const partIndex = this.startTextPart(message);
		this.appendText(message, partIndex, text);
		this.endTextPart(message, partIndex, text);
		this.closeMessage();
	}

	private textStart(index: number): void {
		if (this.options.structured) {
			this.blocks.set(index, { kind: "buffered", text: "" });
			return;
		}
		const message = this.ensureMessage();
		this.blocks.set(index, { kind: "text", message, partIndex: this.startTextPart(message) });
	}

	private textDelta(index: number, delta: string): void {
		const block = this.blocks.get(index);
		if (block?.kind === "buffered") block.text += delta;
		else if (block?.kind === "text") this.appendText(block.message, block.partIndex, delta);
	}

	private textEnd(index: number, content: string): void {
		const block = this.blocks.get(index);
		this.blocks.delete(index);
		if (block?.kind === "buffered") {
			const text = content ?? block.text;
			if (text.trim()) this.bufferedTexts.push(text);
		} else if (block?.kind === "text") {
			this.endTextPart(block.message, block.partIndex, content ?? block.message.item.content[block.partIndex].text);
		}
	}

	// ---- reasoning ----

	private thinkingStart(index: number): void {
		this.closeMessage();
		const item: Item = { id: newId("rs"), type: "reasoning", summary: [], status: "in_progress" };
		if (this.options.reasoningMode === "content") item.content = [];
		if (this.options.includeEncryptedReasoning) item.encrypted_content = null;
		const outputIndex = this.addItem(item);
		if (this.options.reasoningMode === "summary") {
			const part = { type: "summary_text", text: "" };
			item.summary.push(part);
			this.emit("response.reasoning_summary_part.added", { item_id: item.id, output_index: outputIndex, summary_index: 0, part });
		} else {
			const part = { type: "reasoning_text", text: "" };
			item.content.push(part);
			this.emit("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: 0, part });
		}
		this.blocks.set(index, { kind: "thinking", item, outputIndex });
	}

	private thinkingDelta(index: number, delta: string): void {
		const block = this.blocks.get(index);
		if (block?.kind !== "thinking" || !delta) return;
		const { item, outputIndex } = block;
		if (this.options.reasoningMode === "summary") {
			item.summary[0].text += delta;
			this.emit("response.reasoning_summary_text.delta", { item_id: item.id, output_index: outputIndex, summary_index: 0, delta });
		} else {
			item.content[0].text += delta;
			this.emit("response.reasoning_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta });
		}
	}

	private thinkingEnd(index: number, content: string | undefined, part: Json): void {
		const block = this.blocks.get(index);
		if (block?.kind !== "thinking") return;
		this.blocks.delete(index);
		const { item, outputIndex } = block;
		if (this.options.reasoningMode === "summary") {
			const summary = item.summary[0];
			summary.text = content ?? summary.text;
			this.emit("response.reasoning_summary_text.done", { item_id: item.id, output_index: outputIndex, summary_index: 0, text: summary.text });
			this.emit("response.reasoning_summary_part.done", { item_id: item.id, output_index: outputIndex, summary_index: 0, part: summary });
			if (!summary.text) item.summary = [];
		} else {
			const reasoning = item.content[0];
			reasoning.text = content ?? reasoning.text;
			this.emit("response.reasoning_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: reasoning.text });
			this.emit("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: 0, part: reasoning });
		}
		if (this.options.includeEncryptedReasoning) {
			const payload: ReasoningPayload = {
				v: 1,
				provider: this.response.model.split("/")[0] ?? "",
				model: this.response.model.split("/").slice(1).join("/"),
				thinking: content ?? "",
				...(part?.thinkingSignature ? { signature: part.thinkingSignature } : {}),
				...(part?.redacted ? { redacted: true } : {}),
			};
			item.encrypted_content = encodeOpaque(payload);
		}
		item.status = "completed";
		this.doneItem(item, outputIndex);
	}

	// ---- tool calls ----

	private toolStart(index: number, partial: Json): void {
		this.closeMessage();
		const block: Block = { kind: "tool", toolKind: "pi", outputIndex: -1, started: false };
		this.blocks.set(index, block);
		if (partial?.name) this.materializeTool(block, partial);
	}

	/** Creates the output item once the tool name is known. */
	private materializeTool(block: Extract<Block, { kind: "tool" }>, call: Json): void {
		if (block.started) return;
		block.started = true;
		const kind = this.options.classifyTool(call.name);
		block.toolKind = kind;
		if (kind === "structured") {
			const message = this.ensureMessage();
			block.message = message;
			block.partIndex = this.startTextPart(message);
			return;
		}
		let item: Item | undefined;
		if (kind === "function") {
			item = { id: newId("fc"), type: "function_call", status: "in_progress", call_id: call.id ?? "", name: call.name, arguments: "" };
		} else if (kind === "custom") {
			item = { id: newId("ctc"), type: "custom_tool_call", status: "in_progress", call_id: call.id ?? "", name: call.name, input: "" };
		} else if (this.options.toolCallItems === "mcp_call") {
			item = {
				id: newId("mcp"),
				type: "mcp_call",
				status: "in_progress",
				server_label: "pi",
				name: call.name,
				arguments: "",
				output: null,
				error: null,
				approval_request_id: null,
			};
		}
		if (!item) return;
		block.item = item;
		block.outputIndex = this.addItem(item);
		if (kind === "pi") this.emit("response.mcp_call.in_progress", { item_id: item.id, output_index: block.outputIndex });
	}

	private toolDelta(index: number, delta: string, partial: Json): void {
		const block = this.blocks.get(index);
		if (block?.kind !== "tool" || !delta) return;
		if (!block.started && partial?.name) this.materializeTool(block, partial);
		if (!block.started) return;
		if (block.toolKind === "structured" && block.message && block.partIndex !== undefined) {
			this.appendText(block.message, block.partIndex, delta);
			return;
		}
		const item = block.item;
		if (!item) return;
		if (block.toolKind === "function") {
			item.arguments += delta;
			this.emit("response.function_call_arguments.delta", { item_id: item.id, output_index: block.outputIndex, delta });
		} else if (block.toolKind === "pi") {
			item.arguments += delta;
			this.emit("response.mcp_call_arguments.delta", { item_id: item.id, output_index: block.outputIndex, delta });
		}
	}

	private toolEnd(index: number, toolCall: Json): void {
		const block = this.blocks.get(index);
		if (block?.kind !== "tool") return;
		this.blocks.delete(index);
		if (!block.started) this.materializeTool(block, toolCall);
		const args = JSON.stringify(toolCall.arguments ?? {});
		if (block.toolKind === "structured" && block.message && block.partIndex !== undefined) {
			this.endTextPart(block.message, block.partIndex, args);
			this.closeMessage();
			this.structuredEmitted = true;
			return;
		}
		const item = block.item;
		if (!item) return;
		if (block.toolKind === "function") {
			item.call_id = toolCall.id;
			item.arguments = args;
			item.status = "completed";
			this.emit("response.function_call_arguments.done", { item_id: item.id, output_index: block.outputIndex, name: item.name, arguments: args });
			this.doneItem(item, block.outputIndex);
		} else if (block.toolKind === "custom") {
			const input = typeof toolCall.arguments?.input === "string" ? toolCall.arguments.input : args;
			item.call_id = toolCall.id;
			item.input = input;
			item.status = "completed";
			this.emit("response.custom_tool_call_input.delta", { item_id: item.id, output_index: block.outputIndex, delta: input });
			this.emit("response.custom_tool_call_input.done", { item_id: item.id, output_index: block.outputIndex, input });
			this.doneItem(item, block.outputIndex);
		} else {
			item.arguments = args;
			this.emit("response.mcp_call_arguments.done", { item_id: item.id, output_index: block.outputIndex, arguments: args });
			this.toolItems.set(toolCall.id, { item, outputIndex: block.outputIndex });
		}
	}

	private handleToolExecutionEnd(toolCallId: string, result: Json, isError: boolean): void {
		const entry = this.toolItems.get(toolCallId);
		if (!entry) return;
		this.toolItems.delete(toolCallId);
		const { item, outputIndex } = entry;
		const text = toolResultText(result);
		if (isError) {
			item.status = "failed";
			item.error = text;
			this.emit("response.mcp_call.failed", { item_id: item.id, output_index: outputIndex });
		} else {
			item.status = "completed";
			item.output = text;
			this.emit("response.mcp_call.completed", { item_id: item.id, output_index: outputIndex });
		}
		this.doneItem(item, outputIndex);
	}

	/** Records a server-side tool call against `max_tool_calls`. */
	countToolCall(): number {
		return ++this.totals.toolCallCount;
	}

	private abandonBlock(block: Block): void {
		if (block.kind === "thinking") {
			block.item.status = "incomplete";
			this.doneItem(block.item, block.outputIndex);
		} else if (block.kind === "tool" && block.item && block.item.status === "in_progress" && !this.toolItemsHas(block.item)) {
			block.item.status = "incomplete";
			this.doneItem(block.item, block.outputIndex);
		} else if (block.kind === "buffered" && block.text.trim()) {
			this.bufferedTexts.push(block.text);
		}
	}

	private toolItemsHas(item: Item): boolean {
		for (const entry of this.toolItems.values()) if (entry.item === item) return true;
		return false;
	}
}

export function emptyUsage(): ResponseUsage {
	return {
		input_tokens: 0,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 0,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 0,
	};
}

export function toolResultText(result: Json): string {
	const content: Json[] = Array.isArray(result?.content) ? result.content : [];
	const text = content
		.map((part) => (part.type === "text" ? part.text : part.type === "image" ? `[image ${part.mimeType ?? ""}]` : ""))
		.filter(Boolean)
		.join("\n");
	return text || (typeof result === "string" ? result : "");
}

/** Builds the event sequence of an already finished response (for `GET ?stream=true` without a live log). */
export function synthesizeEvents(response: ResponseObject): StreamEvent[] {
	const events: StreamEvent[] = [];
	let sequence = 0;
	const push = (type: string, data: Record<string, Json>) => events.push({ type, sequence_number: sequence++, ...structuredClone(data) });
	const shell = { ...response, status: "in_progress", output: [], usage: null, completed_at: null };
	push("response.created", { response: shell });
	push("response.in_progress", { response: shell });
	response.output.forEach((item, outputIndex) => {
		const added = item.type === "message" ? { ...item, status: "in_progress", content: [] } : { ...item, status: "in_progress" };
		push("response.output_item.added", { output_index: outputIndex, item: added });
		if (item.type === "message") {
			(item.content as Json[]).forEach((part, contentIndex) => {
				push("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { ...part, text: "" } });
				push("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text, logprobs: [] });
				push("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text, logprobs: [] });
				push("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, part });
			});
		} else if (item.type === "function_call") {
			push("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: item.arguments });
			push("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, name: item.name, arguments: item.arguments });
		}
		push("response.output_item.done", { output_index: outputIndex, item });
	});
	const terminal =
		response.status === "completed"
			? "response.completed"
			: response.status === "incomplete"
				? "response.incomplete"
				: response.status === "cancelled"
					? "response.cancelled"
					: response.status === "failed"
						? "response.failed"
						: undefined;
	if (terminal) push(terminal, { response });
	return events;
}
