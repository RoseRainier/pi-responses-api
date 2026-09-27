// npm install openai && node examples/basic.mjs
import OpenAI from "openai";

const client = new OpenAI({ baseURL: process.env.PI_RESPONSES_URL ?? "http://127.0.0.1:8321/v1", apiKey: process.env.PI_RESPONSES_API_KEY ?? "unused" });

// 1. Streaming text; Pi tool calls arrive as mcp_call items.
const stream = client.responses.stream({ model: "pi", input: "Which files are in the current directory?", reasoning: { effort: "low" } });
for await (const event of stream) {
	if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
	if (event.type === "response.output_item.done" && event.item.type === "mcp_call") console.log(`\n[pi tool] ${event.item.name} ${event.item.arguments}`);
}
const first = await stream.finalResponse();
console.log("\n");

// 2. Continue the conversation.
const second = await client.responses.create({ model: "pi", previous_response_id: first.id, input: "Which of them is the largest?" });
console.log(second.output_text, "\n");

// 3. Client-side function calling.
const tools = [
	{
		type: "function",
		name: "get_weather",
		description: "Get the current weather for a city",
		parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
		strict: true,
	},
];
let response = await client.responses.create({ model: "pi", input: "What's the weather in Tokyo?", tools });
for (const call of response.output.filter((item) => item.type === "function_call")) {
	const { city } = JSON.parse(call.arguments);
	response = await client.responses.create({
		model: "pi",
		previous_response_id: response.id,
		tools,
		input: [{ type: "function_call_output", call_id: call.call_id, output: `Sunny and 24°C in ${city}` }],
	});
}
console.log(response.output_text, "\n");

// 4. Structured output.
const structured = await client.responses.create({
	model: "pi",
	input: "Extract the person: 'Bob, 42, lives in Osaka'.",
	text: {
		format: {
			type: "json_schema",
			name: "person",
			strict: true,
			schema: { type: "object", properties: { name: { type: "string" }, age: { type: "integer" }, city: { type: "string" } }, required: ["name", "age", "city"], additionalProperties: false },
		},
	},
});
console.log(JSON.parse(structured.output_text));
