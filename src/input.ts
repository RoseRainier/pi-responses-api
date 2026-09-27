import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { badRequest } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Item, Json } from "./types.ts";

// Structural copies of the Pi message types this module produces. They match
// `@earendil-works/pi-ai` without importing it, so the module stays testable in isolation.
export interface TextPart {
	type: "text";
	text: string;
}
export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}
export interface ThinkingPart {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}
export interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, Json>;
}
export interface UserMessage {
	role: "user";
	content: (TextPart | ImagePart)[];
	timestamp: number;
}
export interface AssistantMessage {
	role: "assistant";
	content: (TextPart | ThinkingPart | ToolCallPart)[];
	api: string;
	provider: string;
	model: string;
	usage: ReturnType<typeof zeroUsage>;
	stopReason: "stop" | "toolUse";
	timestamp: number;
}
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextPart | ImagePart)[];
	isError: boolean;
	timestamp: number;
}
export interface CustomMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}
export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage;

export interface TargetModel {
	api: string;
	provider: string;
	id: string;
}

export function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ---------------------------------------------------------------------------
// Opaque payloads for reasoning and compaction items
// ---------------------------------------------------------------------------

const OPAQUE_PREFIX = "pi1.";

/**
 * Encodes Pi state that clients must hand back unchanged (reasoning signatures,
 * compaction summaries). It is not encrypted; it is only opaque to clients.
 */
export function encodeOpaque(value: Json): string {
	return OPAQUE_PREFIX + Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeOpaque<T = Json>(value: unknown): T | undefined {
	if (typeof value !== "string" || !value.startsWith(OPAQUE_PREFIX)) return undefined;
	try {
		return JSON.parse(Buffer.from(value.slice(OPAQUE_PREFIX.length), "base64url").toString("utf8")) as T;
	} catch {
		return undefined;
	}
}

export interface ReasoningPayload {
	v: 1;
	provider: string;
	model: string;
	thinking: string;
	signature?: string;
	redacted?: boolean;
}

export interface CompactionPayload {
	v: 1;
	summary: string;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const ID_PREFIX: Record<string, string> = {
	message: "msg",
	function_call: "fc",
	function_call_output: "fco",
	custom_tool_call: "ctc",
	custom_tool_call_output: "ctco",
	reasoning: "rs",
	compaction: "cmp",
	mcp_call: "mcp",
};

/**
 * Converts request `input` to canonical items: easy messages become `message` items,
 * `item_reference`s are resolved and every item gets an id.
 */
export function normalizeInput(input: unknown, resolveReference: (id: string) => Item | undefined): Item[] {
	if (input === undefined || input === null) return [];
	if (typeof input === "string") {
		return [userTextItem(input)];
	}
	if (!Array.isArray(input)) throw badRequest("'input' must be a string or an array of items.", "input");
	return input.map((raw, index) => normalizeItem(raw, index, resolveReference));
}

export function userTextItem(text: string): Item {
	return {
		type: "message",
		id: newId("msg"),
		role: "user",
		status: "completed",
		content: [{ type: "input_text", text }],
	};
}

function normalizeItem(raw: unknown, index: number, resolveReference: (id: string) => Item | undefined): Item {
	if (typeof raw !== "object" || raw === null) throw badRequest(`input[${index}] must be an object.`, `input[${index}]`);
	const item = { ...(raw as Item) };
	if (item.type === "item_reference") {
		const found = typeof item.id === "string" ? resolveReference(item.id) : undefined;
		if (!found) throw badRequest(`Item with id '${item.id}' not found.`, `input[${index}].id`);
		return structuredClone(found);
	}
	if (item.type === undefined || item.type === "message") {
		const role = item.role;
		if (!["user", "assistant", "system", "developer"].includes(role)) {
			throw badRequest(`input[${index}].role must be one of user, assistant, system, developer.`, `input[${index}].role`);
		}
		const content = normalizeMessageContent(item.content, role, index);
		const normalized: Item = { ...item, type: "message", role, content, id: item.id ?? newId("msg") };
		normalized.status ??= "completed";
		return normalized;
	}
	item.id ??= newId(ID_PREFIX[item.type] ?? "item");
	return item;
}

function normalizeMessageContent(content: unknown, role: string, index: number): Json[] {
	const textType = role === "assistant" ? "output_text" : "input_text";
	if (typeof content === "string") {
		return role === "assistant"
			? [{ type: "output_text", text: content, annotations: [], logprobs: [] }]
			: [{ type: textType, text: content }];
	}
	if (!Array.isArray(content)) throw badRequest(`input[${index}].content must be a string or an array.`, `input[${index}].content`);
	return content.map((part) => (typeof part === "string" ? { type: textType, text: part } : part));
}

// ---------------------------------------------------------------------------
// Conversion to Pi messages
// ---------------------------------------------------------------------------

export interface ConversionContext {
	model: TargetModel;
	/** Directory for binary attachments that the agent reads from disk. */
	uploadDir: string;
	/** Known function call names by call id (from earlier turns). */
	callNames: Map<string, string>;
	/** Called for non-fatal problems (unsupported item types, ...). */
	warn: (message: string) => void;
	fetchImpl?: typeof fetch;
}

export interface ConvertedHistory {
	messages: PiMessage[];
	/** Text of system/developer messages found in the items. */
	instructions: string[];
}

const ASSISTANT_SIDE = new Set(["reasoning", "function_call", "custom_tool_call", "mcp_call", "compaction"]);

export function isAssistantSideItem(item: Item): boolean {
	if (item.type === "message") return item.role === "assistant";
	return ASSISTANT_SIDE.has(item.type) && item.type !== "compaction";
}

export function isToolOutputItem(item: Item): boolean {
	return item.type === "function_call_output" || item.type === "custom_tool_call_output";
}

/**
 * Converts Responses items to Pi transcript messages. Consecutive assistant-side items
 * (assistant text, reasoning, calls) are merged into one assistant message, followed by
 * the tool results of any completed server-side calls.
 */
export async function itemsToMessages(items: Item[], ctx: ConversionContext): Promise<ConvertedHistory> {
	const messages: PiMessage[] = [];
	const instructions: string[] = [];
	let assistant: AssistantMessage | undefined;
	let deferredResults: ToolResultMessage[] = [];

	const flushAssistant = () => {
		if (!assistant) return;
		if (assistant.content.length > 0) {
			assistant.stopReason = assistant.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
			messages.push(assistant);
		}
		messages.push(...deferredResults);
		assistant = undefined;
		deferredResults = [];
	};
	const openAssistant = (): AssistantMessage => {
		assistant ??= {
			role: "assistant",
			content: [],
			api: ctx.model.api,
			provider: ctx.model.provider,
			model: ctx.model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		return assistant;
	};

	for (const item of items) {
		switch (item.type) {
			case "message": {
				if (item.role === "assistant") {
					const text = messageText(item);
					if (text) openAssistant().content.push({ type: "text", text });
					break;
				}
				flushAssistant();
				if (item.role === "system" || item.role === "developer") {
					const text = messageText(item);
					if (text) instructions.push(text);
					break;
				}
				messages.push(await userMessageFromItem(item, ctx));
				break;
			}
			case "reasoning": {
				const thinking = reasoningToThinking(item, ctx.model);
				if (thinking) openAssistant().content.push(thinking);
				break;
			}
			case "function_call": {
				ctx.callNames.set(item.call_id, item.name);
				openAssistant().content.push({
					type: "toolCall",
					id: item.call_id,
					name: item.name,
					arguments: parseArguments(item.arguments, ctx),
				});
				break;
			}
			case "custom_tool_call": {
				ctx.callNames.set(item.call_id, item.name);
				openAssistant().content.push({
					type: "toolCall",
					id: item.call_id,
					name: item.name,
					arguments: { input: typeof item.input === "string" ? item.input : "" },
				});
				break;
			}
			case "mcp_call": {
				// Server-side Pi tool calls echoed back by stateless clients.
				const callId = String(item.id);
				openAssistant().content.push({ type: "toolCall", id: callId, name: item.name, arguments: parseArguments(item.arguments, ctx) });
				const output = item.error ?? item.output ?? "";
				deferredResults.push({
					role: "toolResult",
					toolCallId: callId,
					toolName: item.name,
					content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
					isError: Boolean(item.error),
					timestamp: Date.now(),
				});
				break;
			}
			case "function_call_output":
			case "custom_tool_call_output": {
				flushAssistant();
				messages.push(await toolOutputToResult(item, ctx));
				break;
			}
			case "compaction": {
				flushAssistant();
				const payload = decodeOpaque<CompactionPayload>(item.encrypted_content);
				if (payload?.summary) {
					messages.push({
						role: "custom",
						customType: "responses-api-compaction",
						content: `The earlier part of this conversation was compacted. Summary:\n\n${payload.summary}`,
						display: false,
						timestamp: Date.now(),
					});
				} else {
					ctx.warn("Ignored a compaction item that was not produced by this server.");
				}
				break;
			}
			default:
				ctx.warn(`Ignored unsupported input item type '${item.type}'.`);
		}
	}
	flushAssistant();
	return { messages, instructions };
}

export function messageText(item: Item): string {
	if (!Array.isArray(item.content)) return typeof item.content === "string" ? item.content : "";
	return item.content
		.map((part: Json) => {
			if (typeof part === "string") return part;
			if (part.type === "input_text" || part.type === "output_text" || part.type === "text") return part.text ?? "";
			if (part.type === "refusal") return part.refusal ?? "";
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function parseArguments(value: unknown, ctx: ConversionContext): Record<string, Json> {
	if (typeof value === "object" && value !== null) return value as Record<string, Json>;
	if (typeof value !== "string" || value.trim() === "") return {};
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
	} catch {
		ctx.warn("A function_call item had arguments that are not valid JSON.");
		return { raw: value };
	}
}

function reasoningToThinking(item: Item, model: TargetModel): ThinkingPart | undefined {
	const payload = decodeOpaque<ReasoningPayload>(item.encrypted_content);
	if (payload) {
		const sameModel = payload.provider === model.provider && payload.model === model.id;
		return {
			type: "thinking",
			thinking: payload.thinking,
			...(sameModel && payload.signature ? { thinkingSignature: payload.signature } : {}),
			...(sameModel && payload.redacted ? { redacted: true } : {}),
		};
	}
	const texts = [...(Array.isArray(item.content) ? item.content : []), ...(Array.isArray(item.summary) ? item.summary : [])]
		.map((part: Json) => part?.text)
		.filter((text: unknown): text is string => typeof text === "string" && text.length > 0);
	return texts.length > 0 ? { type: "thinking", thinking: texts.join("\n\n") } : undefined;
}

async function userMessageFromItem(item: Item, ctx: ConversionContext): Promise<UserMessage> {
	const parts = Array.isArray(item.content) ? item.content : [{ type: "input_text", text: String(item.content ?? "") }];
	return { role: "user", content: await contentPartsToPi(parts, ctx), timestamp: Date.now() };
}

async function toolOutputToResult(item: Item, ctx: ConversionContext): Promise<ToolResultMessage> {
	const output = item.output;
	let content: (TextPart | ImagePart)[];
	if (typeof output === "string") content = [{ type: "text", text: output }];
	else if (Array.isArray(output)) content = await contentPartsToPi(output, ctx);
	else content = [{ type: "text", text: JSON.stringify(output ?? "") }];
	if (content.length === 0) content = [{ type: "text", text: "" }];
	return {
		role: "toolResult",
		toolCallId: item.call_id,
		toolName: ctx.callNames.get(item.call_id) ?? "unknown",
		content,
		isError: item.status === "incomplete",
		timestamp: Date.now(),
	};
}

/** Converts Responses content parts (`input_text`, `input_image`, `input_file`) to Pi content. */
export async function contentPartsToPi(parts: Json[], ctx: ConversionContext): Promise<(TextPart | ImagePart)[]> {
	const result: (TextPart | ImagePart)[] = [];
	for (const part of parts) {
		if (typeof part === "string") {
			result.push({ type: "text", text: part });
			continue;
		}
		switch (part?.type) {
			case "input_text":
			case "output_text":
			case "text":
				if (part.text) result.push({ type: "text", text: part.text });
				break;
			case "refusal":
				if (part.refusal) result.push({ type: "text", text: part.refusal });
				break;
			case "input_image":
				result.push(await imagePart(part, ctx));
				break;
			case "input_file":
				result.push(await filePart(part, ctx));
				break;
			default:
				ctx.warn(`Ignored unsupported content part type '${part?.type}'.`);
		}
	}
	return result;
}

interface LoadedData {
	data: Buffer;
	mimeType: string | undefined;
}

function parseDataUrl(url: string): LoadedData | undefined {
	const match = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(url);
	if (!match) return undefined;
	const [, mimeType, , base64, payload] = match;
	const data = base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
	return { data, mimeType: mimeType || undefined };
}

async function loadUrl(url: string, ctx: ConversionContext, param: string): Promise<LoadedData> {
	const dataUrl = parseDataUrl(url);
	if (dataUrl) return dataUrl;
	if (!/^https?:\/\//i.test(url)) throw badRequest(`Unsupported URL in ${param}. Use a data: or http(s) URL.`, param);
	const response = await (ctx.fetchImpl ?? fetch)(url);
	if (!response.ok) throw badRequest(`Failed to download ${url}: HTTP ${response.status}`, param);
	const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
	return { data: Buffer.from(await response.arrayBuffer()), mimeType };
}

function rejectFileId(part: Json, param: string): never {
	throw badRequest(
		`'file_id' references (${part.file_id}) are not supported by this server. Send the content inline as a data URL or as an http(s) URL.`,
		param,
		"unsupported_parameter",
	);
}

async function imagePart(part: Json, ctx: ConversionContext): Promise<ImagePart> {
	if (part.file_id && !part.image_url) rejectFileId(part, "input_image.file_id");
	const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
	if (typeof url !== "string") throw badRequest("input_image requires 'image_url'.", "input_image.image_url");
	const loaded = await loadUrl(url, ctx, "input_image.image_url");
	return { type: "image", data: loaded.data.toString("base64"), mimeType: loaded.mimeType ?? sniffImageType(loaded.data) };
}

function sniffImageType(data: Buffer): string {
	if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
	if (data.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
	if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return "image/png";
}

const TEXT_EXTENSIONS = new Set([
	".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
	".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh",
	".bash", ".zsh", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".sql", ".log", ".swift", ".scala", ".lua", ".r",
	".tex", ".rst", ".diff", ".patch", ".env", ".svg",
]);

function looksLikeText(mimeType: string | undefined, filename: string, data: Buffer): boolean {
	if (mimeType?.startsWith("text/")) return true;
	if (mimeType && /(json|xml|javascript|yaml|toml|csv|x-sh|sql|markdown)/.test(mimeType)) return true;
	if (TEXT_EXTENSIONS.has(extname(filename).toLowerCase())) return true;
	if (mimeType && mimeType !== "application/octet-stream") return false;
	const sample = data.subarray(0, 4096);
	return !sample.includes(0) && !sample.toString("utf8").includes("�");
}

async function filePart(part: Json, ctx: ConversionContext): Promise<TextPart | ImagePart> {
	if (part.file_id && !part.file_data && !part.file_url) rejectFileId(part, "input_file.file_id");
	let loaded: LoadedData;
	if (typeof part.file_data === "string") {
		loaded = parseDataUrl(part.file_data) ?? { data: Buffer.from(part.file_data, "base64"), mimeType: undefined };
	} else if (typeof part.file_url === "string") {
		loaded = await loadUrl(part.file_url, ctx, "input_file.file_url");
	} else {
		throw badRequest("input_file requires 'file_data' or 'file_url'.", "input_file");
	}
	const filename = basename(String(part.filename ?? (part.file_url ? new URL(part.file_url).pathname : "") ?? "")) || "attachment";
	if (loaded.mimeType?.startsWith("image/")) {
		return { type: "image", data: loaded.data.toString("base64"), mimeType: loaded.mimeType };
	}
	if (looksLikeText(loaded.mimeType, filename, loaded.data)) {
		return { type: "text", text: `<file name="${filename}">\n${loaded.data.toString("utf8")}\n</file>` };
	}
	mkdirSync(ctx.uploadDir, { recursive: true });
	const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_");
	const path = join(ctx.uploadDir, `${newId("file").slice(0, 21)}-${safeName}`);
	writeFileSync(path, loaded.data);
	return {
		type: "text",
		text: `[Attached file "${filename}" (${loaded.mimeType ?? "binary"}, ${loaded.data.length} bytes) was saved to ${path}. Use your tools to inspect it if needed.]`,
	};
}
