import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseCommandArgs, validateConfig, defaultConfig } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import {
	type ConversionContext,
	decodeOpaque,
	encodeOpaque,
	itemsToMessages,
	normalizeInput,
} from "../src/input.ts";
import { paginate } from "../src/pagination.ts";
import { normalizeToolChoice, patchPayload } from "../src/payload.ts";
import { ResponseRun, synthesizeEvents, type ToolKind } from "../src/run.ts";
import { Store } from "../src/store.ts";
import type { ResponseObject, StreamEvent } from "../src/types.ts";

const model = { api: "openai-responses", provider: "openai", id: "gpt-test" };

function ctx(overrides: Partial<ConversionContext> = {}): ConversionContext & { warnings: string[] } {
	const warnings: string[] = [];
	return {
		model,
		uploadDir: mkdtempSync(join(tmpdir(), "pi-resp-")),
		callNames: new Map(),
		warn: (message) => warnings.push(message),
		warnings,
		...overrides,
	};
}

describe("normalizeInput", () => {
	it("turns a string into a user message", () => {
		const [item] = normalizeInput("hi", () => undefined);
		assert.equal(item.type, "message");
		assert.equal(item.role, "user");
		assert.deepEqual(item.content, [{ type: "input_text", text: "hi" }]);
		assert.match(item.id ?? "", /^msg_/);
	});

	it("normalizes easy messages and keeps other items", () => {
		const items = normalizeInput(
			[
				{ role: "assistant", content: "done" },
				{ type: "function_call_output", call_id: "c1", output: "x" },
			],
			() => undefined,
		);
		assert.equal(items[0].content[0].type, "output_text");
		assert.equal(items[1].type, "function_call_output");
		assert.match(items[1].id ?? "", /^fco_/);
	});

	it("resolves item references", () => {
		const stored = { type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "old" }] };
		const [item] = normalizeInput([{ type: "item_reference", id: "msg_1" }], (id) => (id === "msg_1" ? stored : undefined));
		assert.deepEqual(item, stored);
		assert.throws(() => normalizeInput([{ type: "item_reference", id: "nope" }], () => undefined), ApiError);
	});

	it("rejects invalid roles", () => {
		assert.throws(() => normalizeInput([{ role: "robot", content: "x" }], () => undefined), /role/);
	});
});

describe("itemsToMessages", () => {
	it("groups assistant-side items and pairs tool outputs", async () => {
		const items = normalizeInput(
			[
				{ role: "developer", content: "Be terse." },
				{ role: "user", content: "weather?" },
				{ type: "reasoning", summary: [{ type: "summary_text", text: "need tool" }] },
				{ type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' },
				{ type: "function_call_output", call_id: "c1", output: "sunny" },
				{ role: "assistant", content: "It is sunny." },
			],
			() => undefined,
		);
		const result = await itemsToMessages(items, ctx());
		assert.deepEqual(result.instructions, ["Be terse."]);
		assert.deepEqual(
			result.messages.map((message) => message.role),
			["user", "assistant", "toolResult", "assistant"],
		);
		const assistant = result.messages[1];
		assert.equal(assistant.role, "assistant");
		if (assistant.role !== "assistant") return;
		assert.equal(assistant.stopReason, "toolUse");
		assert.deepEqual(
			assistant.content.map((part) => part.type),
			["thinking", "toolCall"],
		);
		const toolResult = result.messages[2];
		assert.equal(toolResult.role === "toolResult" && toolResult.toolName, "get_weather");
	});

	it("restores reasoning signatures only for the same model", async () => {
		const encrypted = encodeOpaque({ v: 1, provider: "openai", model: "gpt-test", thinking: "hmm", signature: "sig" });
		const items = normalizeInput(
			[
				{ role: "user", content: "q" },
				{ type: "reasoning", summary: [], encrypted_content: encrypted },
				{ role: "assistant", content: "a" },
			],
			() => undefined,
		);
		const same = await itemsToMessages(items, ctx());
		const other = await itemsToMessages(items, ctx({ model: { ...model, id: "other" } }));
		const thinking = (messages: typeof same.messages) => {
			const assistant = messages[1];
			return assistant.role === "assistant" ? assistant.content[0] : undefined;
		};
		assert.deepEqual(thinking(same.messages), { type: "thinking", thinking: "hmm", thinkingSignature: "sig" });
		assert.deepEqual(thinking(other.messages), { type: "thinking", thinking: "hmm" });
	});

	it("expands compaction items and mcp calls", async () => {
		const items = normalizeInput(
			[
				{ type: "compaction", encrypted_content: encodeOpaque({ v: 1, summary: "We discussed X." }) },
				{ role: "user", content: "next" },
				{ type: "mcp_call", id: "mcp_1", server_label: "pi", name: "read", arguments: '{"path":"a"}', output: "file body" },
			],
			() => undefined,
		);
		const result = await itemsToMessages(items, ctx());
		assert.deepEqual(
			result.messages.map((message) => message.role),
			["custom", "user", "assistant", "toolResult"],
		);
		assert.match(String(result.messages[0].role === "custom" && result.messages[0].content), /We discussed X/);
	});

	it("converts images and files", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64");
		const conversion = ctx();
		const items = normalizeInput(
			[
				{
					role: "user",
					content: [
						{ type: "input_image", image_url: `data:image/png;base64,${png}` },
						{ type: "input_file", filename: "a.txt", file_data: `data:text/plain;base64,${Buffer.from("hello").toString("base64")}` },
						{ type: "input_file", filename: "b.pdf", file_data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4").toString("base64")}` },
					],
				},
			],
			() => undefined,
		);
		const result = await itemsToMessages(items, conversion);
		const user = result.messages[0];
		assert.equal(user.role, "user");
		if (user.role !== "user") return;
		assert.deepEqual(user.content[0], { type: "image", data: png, mimeType: "image/png" });
		assert.equal(user.content[1].type === "text" && user.content[1].text, '<file name="a.txt">\nhello\n</file>');
		const saved = user.content[2].type === "text" ? /saved to (\S+)\./.exec(user.content[2].text)?.[1] : undefined;
		assert.ok(saved && existsSync(saved));
		assert.equal(readFileSync(saved, "utf8"), "%PDF-1.4");
	});

	it("rejects file_id references", async () => {
		const items = normalizeInput([{ role: "user", content: [{ type: "input_image", file_id: "file_1" }] }], () => undefined);
		await assert.rejects(itemsToMessages(items, ctx()), /file_id/);
	});
});

describe("opaque payloads", () => {
	it("round-trips and ignores foreign values", () => {
		assert.deepEqual(decodeOpaque(encodeOpaque({ a: 1 })), { a: 1 });
		assert.equal(decodeOpaque("gAAAAB-openai-encrypted"), undefined);
	});
});

function skeleton(): ResponseObject {
	return {
		id: "resp_test",
		object: "response",
		created_at: 0,
		completed_at: null,
		status: "in_progress",
		background: false,
		error: null,
		incomplete_details: null,
		instructions: null,
		max_output_tokens: null,
		max_tool_calls: null,
		model: "openai/gpt-test",
		output: [],
		parallel_tool_calls: true,
		previous_response_id: null,
		conversation: null,
		prompt: null,
		prompt_cache_key: null,
		reasoning: { effort: null, summary: null },
		safety_identifier: null,
		service_tier: "default",
		store: true,
		temperature: null,
		text: { format: { type: "text" }, verbosity: "medium" },
		tool_choice: "auto",
		tools: [],
		top_logprobs: 0,
		top_p: null,
		truncation: "disabled",
		usage: null,
		user: null,
		metadata: {},
	};
}

function makeRun(kinds: Record<string, ToolKind> = {}, options: { structured?: boolean; reasoningMode?: "summary" | "content" } = {}) {
	const run = new ResponseRun({
		response: skeleton(),
		classifyTool: (name) => kinds[name] ?? "pi",
		toolCallItems: "mcp_call",
		reasoningMode: options.reasoningMode ?? "summary",
		includeEncryptedReasoning: true,
		structured: options.structured ?? false,
	});
	const events: StreamEvent[] = [];
	run.subscribe((event) => events.push(event));
	return { run, events };
}

const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, reasoning: 2, totalTokens: 18, cost: { total: 0.01 } };

function assistantStream(run: ResponseRun, content: Array<Record<string, unknown>>, stopReason = "stop") {
	const partial = { role: "assistant", content };
	run.handleSessionEvent({ type: "message_start", message: { role: "assistant" } });
	content.forEach((part, index) => {
		const update = (assistantMessageEvent: Record<string, unknown>) =>
			run.handleSessionEvent({ type: "message_update", assistantMessageEvent: { contentIndex: index, partial, ...assistantMessageEvent } });
		if (part.type === "text") {
			update({ type: "text_start" });
			update({ type: "text_delta", delta: part.text });
			update({ type: "text_end", content: part.text });
		} else if (part.type === "thinking") {
			update({ type: "thinking_start" });
			update({ type: "thinking_delta", delta: part.thinking });
			update({ type: "thinking_end", content: part.thinking });
		} else if (part.type === "toolCall") {
			update({ type: "toolcall_start" });
			update({ type: "toolcall_delta", delta: JSON.stringify(part.arguments) });
			update({ type: "toolcall_end", toolCall: part });
		}
	});
	run.handleSessionEvent({ type: "message_end", message: { role: "assistant", content, stopReason, usage } });
}

describe("ResponseRun", () => {
	it("maps text, reasoning and usage", () => {
		const { run, events } = makeRun();
		run.start();
		assistantStream(run, [
			{ type: "thinking", thinking: "let me think" },
			{ type: "text", text: "Hello" },
		]);
		const response = run.finish("completed");
		assert.deepEqual(
			response.output.map((item) => item.type),
			["reasoning", "message"],
		);
		assert.equal(response.output[0].summary[0].text, "let me think");
		assert.ok(decodeOpaque(response.output[0].encrypted_content));
		assert.equal(response.output[1].content[0].text, "Hello");
		assert.deepEqual(response.usage, {
			input_tokens: 13,
			input_tokens_details: { cached_tokens: 3 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 2 },
			total_tokens: 18,
		});
		assert.equal(events[0].type, "response.created");
		assert.equal(events.at(-1)?.type, "response.completed");
		assert.deepEqual(
			events.map((event) => event.sequence_number),
			events.map((_, index) => index),
		);
		assert.ok(events.some((event) => event.type === "response.reasoning_summary_text.delta"));
		assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.delta === "Hello"));
	});

	it("emits function calls for client tools and mcp calls for Pi tools", () => {
		const { run, events } = makeRun({ get_weather: "function" });
		run.start();
		assistantStream(
			run,
			[
				{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
				{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "a.txt" } },
			],
			"toolUse",
		);
		run.handleSessionEvent({ type: "tool_execution_end", toolCallId: "call_2", result: { content: [{ type: "text", text: "contents" }] }, isError: false });
		const response = run.finish("completed");
		const [call, mcp] = response.output;
		assert.equal(call.type, "function_call");
		assert.equal(call.call_id, "call_1");
		assert.equal(call.arguments, '{"city":"Paris"}');
		assert.equal(mcp.type, "mcp_call");
		assert.equal(mcp.server_label, "pi");
		assert.equal(mcp.output, "contents");
		assert.equal(mcp.status, "completed");
		assert.ok(events.some((event) => event.type === "response.function_call_arguments.done"));
		assert.ok(events.some((event) => event.type === "response.mcp_call.completed"));
	});

	it("turns the structured output tool into output_text and drops commentary", () => {
		const { run } = makeRun({ structured_output: "structured" }, { structured: true });
		run.start();
		assistantStream(
			run,
			[
				{ type: "text", text: "Here you go:" },
				{ type: "toolCall", id: "call_s", name: "structured_output", arguments: { name: "Alice" } },
			],
			"toolUse",
		);
		const response = run.finish("completed");
		assert.equal(response.output.length, 1);
		assert.equal(response.output[0].content[0].text, '{"name":"Alice"}');
	});

	it("falls back to buffered text when no structured output arrives", () => {
		const { run } = makeRun({}, { structured: true });
		run.start();
		assistantStream(run, [{ type: "text", text: '{"a":1}' }]);
		const response = run.finish("completed");
		assert.equal(response.output[0].content[0].text, '{"a":1}');
	});

	it("replays messages that arrive without stream events", () => {
		const { run } = makeRun();
		run.start();
		run.handleSessionEvent({ type: "message_start", message: { role: "assistant" } });
		run.handleSessionEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "whole" }], stopReason: "stop", usage } });
		const response = run.finish("completed");
		assert.equal(response.output[0].content[0].text, "whole");
	});

	it("marks unfinished items incomplete and reports failures", () => {
		const { run, events } = makeRun();
		run.start();
		run.handleSessionEvent({ type: "message_start", message: { role: "assistant" } });
		run.handleSessionEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: { content: [] } } });
		const response = run.finish("failed", { error: { code: "server_error", message: "boom" } });
		assert.equal(response.output[0].status, "incomplete");
		assert.equal(response.error?.message, "boom");
		assert.equal(events.at(-1)?.type, "response.failed");
	});

	it("synthesizes a replay for stored responses", () => {
		const { run } = makeRun();
		run.start();
		assistantStream(run, [{ type: "text", text: "hi" }]);
		const replay = synthesizeEvents(run.finish("completed"));
		assert.equal(replay[0].type, "response.created");
		assert.equal(replay.at(-1)?.type, "response.completed");
		assert.ok(replay.some((event) => event.type === "response.output_text.delta" && event.delta === "hi"));
	});
});

describe("payload overrides", () => {
	it("patches each provider family", () => {
		const overrides = { maxOutputTokens: 100, temperature: 0.2, topP: 0.9, toolChoice: { mode: "required" as const } };
		assert.deepEqual(patchPayload("openai-responses", { tools: [{}] }, overrides), {
			tools: [{}],
			max_output_tokens: 100,
			temperature: 0.2,
			top_p: 0.9,
			tool_choice: "required",
		});
		assert.deepEqual(patchPayload("anthropic-messages", { tools: [{}], max_tokens: 1 }, overrides), {
			tools: [{}],
			max_tokens: 100,
			temperature: 0.2,
			top_p: 0.9,
			tool_choice: { type: "any" },
		});
		assert.deepEqual(patchPayload("openai-completions", { max_completion_tokens: 1 }, { maxOutputTokens: 5 }), { max_completion_tokens: 5 });
		const google = patchPayload("google-generative-ai", { generationConfig: {} }, { maxOutputTokens: 7 }) as Record<string, any>;
		assert.equal(google.generationConfig.maxOutputTokens, 7);
		assert.equal(patchPayload("unknown-api", "raw", overrides), "raw");
	});

	it("normalizes tool_choice", () => {
		assert.deepEqual(normalizeToolChoice("none"), { mode: "none" });
		assert.deepEqual(normalizeToolChoice({ type: "function", name: "f" }), { mode: "tool", name: "f" });
		assert.equal(normalizeToolChoice(undefined), undefined);
	});
});

describe("config", () => {
	it("parses command arguments", () => {
		assert.deepEqual(parseCommandArgs("start --port 9000 --host 0.0.0.0 --tools read,ls"), {
			action: "start",
			overrides: { port: 9000, host: "0.0.0.0", tools: ["read", "ls"] },
		});
		assert.equal(parseCommandArgs("").action, "status");
		assert.throws(() => parseCommandArgs("start --bogus"), /Unknown option/);
	});

	it("refuses unauthenticated remote binding", () => {
		assert.throws(() => validateConfig({ ...defaultConfig("/tmp/x"), host: "0.0.0.0" }), /API key/);
		validateConfig({ ...defaultConfig("/tmp/x"), host: "0.0.0.0", apiKeys: ["k"] });
	});
});

describe("pagination", () => {
	const items = ["a", "b", "c", "d"].map((id) => ({ type: "message", id }));
	it("pages in both directions", () => {
		const page = paginate(items, new URLSearchParams("limit=2"), "desc");
		assert.deepEqual(
			page.data.map((item: { id: string }) => item.id),
			["d", "c"],
		);
		assert.equal(page.has_more, true);
		const next = paginate(items, new URLSearchParams(`limit=2&after=${page.last_id}`), "desc");
		assert.deepEqual(
			next.data.map((item: { id: string }) => item.id),
			["b", "a"],
		);
		assert.equal(next.has_more, false);
		assert.equal(paginate(items, new URLSearchParams("order=asc&limit=1"), "desc").data[0].id, "a");
	});
});

describe("Store", () => {
	it("persists responses, conversations and item references", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-store-"));
		const store = new Store(dir);
		const response = { ...skeleton(), output: [{ type: "message", id: "msg_out", role: "assistant", content: [] }] };
		store.saveResponse({ response, inputItems: [{ type: "message", id: "msg_in", role: "user", content: [] }] });
		const reopened = new Store(dir);
		assert.equal(reopened.getResponse("resp_test")?.response.id, "resp_test");
		assert.equal(reopened.findItem("msg_out")?.role, "assistant");
		assert.equal(reopened.findItem("msg_in")?.role, "user");
		assert.equal(reopened.getResponse("../etc/passwd"), undefined);
		assert.equal(reopened.deleteResponse("resp_test"), true);
		assert.equal(new Store(dir).getResponse("resp_test"), undefined);
	});
});
