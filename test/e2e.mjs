// End-to-end checks against a running server using the official OpenAI SDK.
//
//   pi-responses-server --port 18321 &
//   RESPONSES_BASE_URL=http://127.0.0.1:18321/v1 node test/e2e.mjs [filter]
//
// These tests call a real model through Pi, so they cost tokens.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";

const baseURL = process.env.RESPONSES_BASE_URL ?? "http://127.0.0.1:18321/v1";
const model = process.env.RESPONSES_MODEL ?? "pi";
const client = new OpenAI({ baseURL, apiKey: process.env.RESPONSES_API_KEY ?? "unused" });
const filter = process.argv[2];

const weatherTool = {
	type: "function",
	name: "get_weather",
	description: "Get the current weather for a city.",
	parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
	strict: true,
};

const tests = {
	async basic() {
		const r = await client.responses.create({ model, input: "Reply with exactly: pong", reasoning: { effort: "low" } });
		assert.equal(r.status, "completed");
		assert.match(r.output_text, /pong/i);
		assert.ok(r.usage.total_tokens > 0);
	},

	async streaming() {
		const stream = client.responses.stream({ model, input: "Count from 1 to 5 separated by spaces.", reasoning: { effort: "low" } });
		const types = new Set();
		let text = "";
		for await (const event of stream) {
			types.add(event.type);
			if (event.type === "response.output_text.delta") text += event.delta;
		}
		const final = await stream.finalResponse();
		for (const type of ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.output_item.done", "response.completed"]) {
			assert.ok(types.has(type), `missing ${type}`);
		}
		assert.equal(text, final.output_text);
		assert.match(final.output_text, /1.*2.*3.*4.*5/s);
	},

	async instructions() {
		const r = await client.responses.create({ model, instructions: "Always answer in uppercase letters only.", input: "Say hello.", reasoning: { effort: "low" } });
		assert.equal(r.output_text, r.output_text.toUpperCase());
	},

	async previousResponse() {
		const first = await client.responses.create({ model, input: "Remember this code word: PAPAYA-42. Just reply OK.", reasoning: { effort: "low" } });
		const second = await client.responses.create({ model, previous_response_id: first.id, input: "What was the code word?", reasoning: { effort: "low" } });
		assert.match(second.output_text, /PAPAYA-42/);
		assert.equal(second.previous_response_id, first.id);
		// Branch from the first response again.
		const branch = await client.responses.create({ model, previous_response_id: first.id, input: "Repeat the code word backwards, characters only.", reasoning: { effort: "low" } });
		assert.match(branch.output_text.replace(/\s/g, ""), /24-?AYAPAP/i);
	},

	async functionCalling() {
		const first = await client.responses.create({ model, input: "What's the weather in Paris? Use the tool.", tools: [weatherTool], reasoning: { effort: "low" } });
		const call = first.output.find((item) => item.type === "function_call");
		assert.ok(call, "expected a function_call");
		assert.equal(call.name, "get_weather");
		assert.equal(JSON.parse(call.arguments).city.toLowerCase(), "paris");
		const second = await client.responses.create({
			model,
			previous_response_id: first.id,
			input: [{ type: "function_call_output", call_id: call.call_id, output: "Rainy, 12°C" }],
			tools: [weatherTool],
			reasoning: { effort: "low" },
		});
		assert.equal(second.status, "completed");
		assert.match(second.output_text, /12/);
	},

	async statelessFunctionCalling() {
		const input = [{ role: "user", content: "What's the weather in Oslo? Use the tool, then answer in one sentence." }];
		const first = await client.responses.create({ model, input, tools: [weatherTool], store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "low" } });
		const call = first.output.find((item) => item.type === "function_call");
		assert.ok(call, "expected a function_call");
		const history = [...input, ...first.output, { type: "function_call_output", call_id: call.call_id, output: "Snowing, -4°C" }];
		const second = await client.responses.create({ model, input: history, tools: [weatherTool], store: false, reasoning: { effort: "low" } });
		assert.match(second.output_text, /-?4/);
		await assert.rejects(client.responses.retrieve(second.id), /not found/i);
	},

	async streamingFunctionCall() {
		const stream = client.responses.stream({ model, input: "Weather in Rome? Use the tool.", tools: [weatherTool], reasoning: { effort: "low" } });
		const types = new Set();
		for await (const event of stream) types.add(event.type);
		const final = await stream.finalResponse();
		assert.ok(types.has("response.function_call_arguments.delta") || types.has("response.function_call_arguments.done"));
		assert.ok(final.output.some((item) => item.type === "function_call"));
	},

	async structuredOutput() {
		const r = await client.responses.create({
			model,
			input: "Extract: Alice is 31 and lives in Kyoto.",
			text: {
				format: {
					type: "json_schema",
					name: "person",
					strict: true,
					schema: { type: "object", properties: { name: { type: "string" }, age: { type: "integer" }, city: { type: "string" } }, required: ["name", "age", "city"], additionalProperties: false },
				},
			},
			reasoning: { effort: "low" },
		});
		const parsed = JSON.parse(r.output_text);
		assert.deepEqual(parsed, { name: "Alice", age: 31, city: "Kyoto" });
	},

	async jsonObject() {
		const r = await client.responses.create({ model, input: "Give me a JSON object with keys a=1 and b=2.", text: { format: { type: "json_object" } }, reasoning: { effort: "low" } });
		assert.deepEqual(JSON.parse(r.output_text), { a: 1, b: 2 });
	},

	async piTools() {
		const cwd = process.env.RESPONSES_CWD;
		if (cwd) writeFileSync(join(cwd, "secret.txt"), "The secret number is 8675309.\n");
		const r = await client.responses.create({ model, input: "Read the file secret.txt in the current directory and tell me the secret number.", reasoning: { effort: "low" } });
		const calls = r.output.filter((item) => item.type === "mcp_call");
		assert.ok(calls.length > 0, "expected mcp_call items for Pi tools");
		assert.equal(calls[0].server_label, "pi");
		assert.ok(calls.every((call) => call.status === "completed"));
		assert.match(r.output_text, /8675309/);
	},

	async reasoningSummary() {
		const stream = client.responses.stream({ model, input: "Is 391 prime? Answer yes or no.", reasoning: { effort: "medium", summary: "auto" } });
		const types = new Set();
		for await (const event of stream) types.add(event.type);
		const final = await stream.finalResponse();
		assert.match(final.output_text, /no/i);
		const reasoning = final.output.find((item) => item.type === "reasoning");
		if (reasoning) assert.ok(Array.isArray(reasoning.summary));
	},

	async background() {
		const created = await client.responses.create({ model, input: "Write a haiku about the sea.", background: true, reasoning: { effort: "low" } });
		assert.ok(["queued", "in_progress"].includes(created.status));
		let r = created;
		for (let i = 0; i < 120 && (r.status === "queued" || r.status === "in_progress"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			r = await client.responses.retrieve(created.id);
		}
		assert.equal(r.status, "completed");
		assert.ok(r.output_text.length > 0);
		// Replay the stream of a finished response.
		const replay = await client.responses.retrieve(created.id, { stream: true });
		const types = [];
		for await (const event of replay) types.push(event.type);
		assert.equal(types[0], "response.created");
		assert.equal(types.at(-1), "response.completed");
	},

	async cancel() {
		const created = await client.responses.create({ model, input: "Write a 2000 word essay about the history of tea.", background: true, reasoning: { effort: "low" } });
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const cancelled = await client.responses.cancel(created.id);
		assert.equal(cancelled.status, "cancelled");
	},

	async inputItemsAndDelete() {
		const r = await client.responses.create({ model, input: [{ role: "user", content: "Say A." }], reasoning: { effort: "low" } });
		const items = await client.responses.inputItems.list(r.id);
		assert.equal(items.data.length, 1);
		assert.equal(items.data[0].type, "message");
		await client.responses.delete(r.id);
		await assert.rejects(client.responses.retrieve(r.id), /not found/i);
	},

	async conversations() {
		const conversation = await client.conversations.create({ items: [{ role: "user", content: "My favourite colour is teal. Reply OK." }], metadata: { topic: "test" } });
		assert.equal(conversation.object, "conversation");
		const r1 = await client.responses.create({ model, conversation: conversation.id, input: "What is my favourite colour?", reasoning: { effort: "low" } });
		assert.match(r1.output_text, /teal/i);
		await client.conversations.items.create(conversation.id, { items: [{ type: "message", role: "user", content: "Also, my pet is a ferret." }] });
		const r2 = await client.responses.create({ model, conversation: conversation.id, input: "What pet do I have?", reasoning: { effort: "low" } });
		assert.match(r2.output_text, /ferret/i);
		const items = await client.conversations.items.list(conversation.id, { order: "asc" });
		assert.ok(items.data.length >= 5);
		const fetched = await client.conversations.retrieve(conversation.id);
		assert.deepEqual(fetched.metadata, { topic: "test" });
		const deleted = await client.conversations.delete(conversation.id);
		assert.equal(deleted.deleted, true);
	},

	async imageInput() {
		// 32x32 solid red PNG
		const png = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
		const r = await client.responses.create({
			model,
			input: [{ role: "user", content: [{ type: "input_text", text: "What colour is this image? One word." }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }],
			reasoning: { effort: "low" },
		});
		assert.match(r.output_text, /red/i);
	},

	async fileInput() {
		const data = Buffer.from("Project codename: BLUE HERON\n").toString("base64");
		const r = await client.responses.create({
			model,
			input: [{ role: "user", content: [{ type: "input_file", filename: "notes.txt", file_data: `data:text/plain;base64,${data}` }, { type: "input_text", text: "What is the project codename?" }] }],
			reasoning: { effort: "low" },
		});
		assert.match(r.output_text, /BLUE HERON/i);
	},

	async inputTokens() {
		const r = await client.responses.inputTokens.count({ model, input: "Hello there, how are you?" });
		assert.equal(r.object, "response.input_tokens");
		assert.ok(r.input_tokens > 0);
	},

	async compact() {
		const first = await client.responses.create({ model, input: "The launch date is March 3rd and the budget is $40k. Reply OK.", reasoning: { effort: "low" } });
		const compacted = await client.responses.compact({ model, previous_response_id: first.id });
		assert.equal(compacted.object, "response.compaction");
		const item = compacted.output.find((entry) => entry.type === "compaction");
		assert.ok(item?.encrypted_content);
		const r = await client.responses.create({ model, input: [...compacted.output, { role: "user", content: "What is the budget?" }], reasoning: { effort: "low" } });
		assert.match(r.output_text, /40/);
	},

	async maxOutputTokens() {
		const r = await client.responses.create({ model: "llama-swap/gemma-4-26B-A4B-Un", input: "Write a long story about dragons.", max_output_tokens: 20 }).catch((error) => error);
		if (r instanceof Error) return; // local model may be offline
		assert.equal(r.status, "incomplete");
		assert.equal(r.incomplete_details.reason, "max_output_tokens");
	},

	async customTool() {
		const tool = { type: "custom", name: "run_sql", description: "Run a SQL query against the analytics database." };
		const r = await client.responses.create({ model, input: "Use run_sql to count the rows in the table named users.", tools: [tool], reasoning: { effort: "low" } });
		const call = r.output.find((item) => item.type === "custom_tool_call");
		assert.ok(call, "expected a custom_tool_call");
		assert.match(call.input, /count/i);
		const r2 = await client.responses.create({ model, previous_response_id: r.id, input: [{ type: "custom_tool_call_output", call_id: call.call_id, output: "42" }], tools: [tool], reasoning: { effort: "low" } });
		assert.match(r2.output_text, /42/);
	},

	async toolChoiceForced() {
		const r = await client.responses.create({ model, input: "Hi!", tools: [weatherTool], tool_choice: { type: "function", name: "get_weather" }, reasoning: { effort: "low" } });
		assert.ok(r.output.some((item) => item.type === "function_call" && item.name === "get_weather"));
	},

	async toolChoiceNone() {
		const r = await client.responses.create({ model, input: "What's the weather in Paris?", tools: [weatherTool], tool_choice: "none", reasoning: { effort: "low" } });
		assert.ok(!r.output.some((item) => item.type === "function_call" || item.type === "mcp_call"));
		assert.ok(r.output_text.length > 0);
	},

	async streamPiTools() {
		const cwd = process.env.RESPONSES_CWD;
		if (cwd) writeFileSync(join(cwd, "fruit.txt"), "banana\n");
		const stream = client.responses.stream({ model, input: "Use a tool to read fruit.txt and tell me the fruit in one word.", reasoning: { effort: "low" } });
		const types = new Set();
		for await (const event of stream) types.add(event.type);
		const final = await stream.finalResponse();
		for (const type of ["response.mcp_call.in_progress", "response.mcp_call_arguments.done", "response.mcp_call.completed"]) assert.ok(types.has(type), `missing ${type}`);
		assert.match(final.output_text, /banana/i);
	},

	async mixedToolsInOneTurn() {
		const cwd = process.env.RESPONSES_CWD;
		if (cwd) writeFileSync(join(cwd, "city.txt"), "Lisbon\n");
		const r = await client.responses.create({
			model,
			input: "In parallel: call get_weather for Madrid AND read city.txt with the read tool. Do both tool calls in your first step.",
			tools: [weatherTool],
			reasoning: { effort: "low" },
		});
		const call = r.output.find((item) => item.type === "function_call");
		assert.ok(call, "expected a function_call");
		const r2 = await client.responses.create({ model, previous_response_id: r.id, input: [{ type: "function_call_output", call_id: call.call_id, output: "Sunny, 30°C" }], tools: [weatherTool], reasoning: { effort: "low" } });
		assert.equal(r2.status, "completed");
		assert.match(r2.output_text, /30/);
	},

	async resumeStreamStartingAfter() {
		const created = await client.responses.create({ model, input: "List three colours.", background: true, reasoning: { effort: "low" } });
		const stream = await client.responses.retrieve(created.id, { stream: true, starting_after: 1 });
		const seqs = [];
		for await (const event of stream) seqs.push(event.sequence_number);
		assert.ok(seqs[0] === 2, `first sequence should be 2, got ${seqs[0]}`);
		const final = await client.responses.retrieve(created.id);
		assert.equal(final.status, "completed");
	},

	async parallelRequests() {
		const results = await Promise.all([1, 2, 3].map((n) => client.responses.create({ model, input: `Reply with only the number ${n}.`, reasoning: { effort: "low" } })));
		results.forEach((r, i) => assert.match(r.output_text, new RegExp(String(i + 1))));
	},

	async errors() {
		await assert.rejects(client.responses.retrieve("resp_doesnotexist"), (error) => error.status === 404);
		await assert.rejects(client.responses.create({ model, previous_response_id: "resp_missing", input: "hi" }), (error) => error.status === 404);
		await assert.rejects(client.responses.create({ model, input: "hi", background: true, store: false }), (error) => error.status === 400);
	},
};

let failed = 0;
for (const [name, test] of Object.entries(tests)) {
	if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
	const started = Date.now();
	try {
		await test();
		console.log(`ok   ${name} (${Date.now() - started} ms)`);
	} catch (error) {
		failed++;
		console.log(`FAIL ${name} (${Date.now() - started} ms)\n     ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n     ")}`);
	}
}
process.exit(failed ? 1 : 0);
