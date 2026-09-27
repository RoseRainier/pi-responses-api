import type { Json } from "./types.ts";

/** Sampling and tool-selection parameters that Pi does not expose, applied to raw provider payloads. */
export interface PayloadOverrides {
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
	/** Normalized tool choice. */
	toolChoice?: { mode: "auto" | "none" | "required" } | { mode: "tool"; name: string };
	parallelToolCalls?: boolean;
}

export function hasOverrides(overrides: PayloadOverrides): boolean {
	return Object.values(overrides).some((value) => value !== undefined);
}

/**
 * Applies overrides to a provider request payload for the given Pi API family.
 * Unknown payload shapes are returned unchanged.
 */
export function patchPayload(api: string, payload: unknown, overrides: PayloadOverrides): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const body = { ...(payload as Record<string, Json>) };
	const { maxOutputTokens, temperature, topP, toolChoice, parallelToolCalls } = overrides;
	const hasTools = (key: string) => Array.isArray(body[key]) && body[key].length > 0;

	switch (api) {
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses": {
			if (maxOutputTokens !== undefined && api !== "openai-codex-responses") body.max_output_tokens = maxOutputTokens;
			if (temperature !== undefined) body.temperature = temperature;
			if (topP !== undefined) body.top_p = topP;
			if (toolChoice && hasTools("tools")) body.tool_choice = responsesToolChoice(toolChoice);
			if (parallelToolCalls !== undefined && hasTools("tools")) body.parallel_tool_calls = parallelToolCalls;
			break;
		}
		case "openai-completions":
		case "mistral-conversations": {
			if (maxOutputTokens !== undefined) {
				if ("max_completion_tokens" in body) body.max_completion_tokens = maxOutputTokens;
				else body.max_tokens = maxOutputTokens;
			}
			if (temperature !== undefined) body.temperature = temperature;
			if (topP !== undefined) body.top_p = topP;
			if (toolChoice && hasTools("tools")) {
				body.tool_choice =
					toolChoice.mode === "tool"
						? { type: "function", function: { name: toolChoice.name } }
						: toolChoice.mode === "required"
							? api === "mistral-conversations"
								? "any"
								: "required"
							: toolChoice.mode;
			}
			if (parallelToolCalls !== undefined && hasTools("tools")) body.parallel_tool_calls = parallelToolCalls;
			break;
		}
		case "anthropic-messages": {
			if (maxOutputTokens !== undefined) body.max_tokens = maxOutputTokens;
			if (temperature !== undefined) body.temperature = temperature;
			if (topP !== undefined) body.top_p = topP;
			if (hasTools("tools") && (toolChoice || parallelToolCalls !== undefined)) {
				const choice: Record<string, Json> =
					toolChoice?.mode === "tool"
						? { type: "tool", name: toolChoice.name }
						: toolChoice?.mode === "required"
							? { type: "any" }
							: toolChoice?.mode === "none"
								? { type: "none" }
								: { type: "auto" };
				if (parallelToolCalls === false && choice.type !== "none") choice.disable_parallel_tool_use = true;
				// Forced tool use is incompatible with extended thinking.
				if (!(body.thinking && (choice.type === "any" || choice.type === "tool"))) body.tool_choice = choice;
			}
			break;
		}
		case "google-generative-ai":
		case "google-vertex": {
			const config = { ...(body.generationConfig ?? body.config ?? {}) };
			if (maxOutputTokens !== undefined) config.maxOutputTokens = maxOutputTokens;
			if (temperature !== undefined) config.temperature = temperature;
			if (topP !== undefined) config.topP = topP;
			if (toolChoice) {
				const mode = toolChoice.mode === "required" || toolChoice.mode === "tool" ? "ANY" : toolChoice.mode === "none" ? "NONE" : "AUTO";
				config.toolConfig = {
					functionCallingConfig: { mode, ...(toolChoice.mode === "tool" ? { allowedFunctionNames: [toolChoice.name] } : {}) },
				};
			}
			if ("config" in body && !("generationConfig" in body)) body.config = config;
			else {
				const { toolConfig, ...generationConfig } = config;
				body.generationConfig = generationConfig;
				if (toolConfig) body.toolConfig = toolConfig;
			}
			break;
		}
		case "bedrock-converse-stream": {
			const inference = { ...(body.inferenceConfig ?? {}) };
			if (maxOutputTokens !== undefined) inference.maxTokens = maxOutputTokens;
			if (temperature !== undefined) inference.temperature = temperature;
			if (topP !== undefined) inference.topP = topP;
			body.inferenceConfig = inference;
			if (toolChoice && body.toolConfig && toolChoice.mode !== "none") {
				body.toolConfig = {
					...body.toolConfig,
					toolChoice: toolChoice.mode === "tool" ? { tool: { name: toolChoice.name } } : toolChoice.mode === "required" ? { any: {} } : { auto: {} },
				};
			}
			break;
		}
		default:
			return payload;
	}
	return body;
}

function responsesToolChoice(choice: NonNullable<PayloadOverrides["toolChoice"]>): Json {
	return choice.mode === "tool" ? { type: "function", name: choice.name } : choice.mode;
}

/** Normalizes the Responses `tool_choice` parameter. */
export function normalizeToolChoice(toolChoice: Json): PayloadOverrides["toolChoice"] {
	if (toolChoice === undefined || toolChoice === null) return undefined;
	if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return { mode: toolChoice };
	if (typeof toolChoice === "object") {
		if ((toolChoice.type === "function" || toolChoice.type === "custom") && typeof toolChoice.name === "string") {
			return { mode: "tool", name: toolChoice.name };
		}
		if (toolChoice.type === "mcp" && typeof toolChoice.name === "string") return { mode: "tool", name: toolChoice.name };
		if (toolChoice.type === "allowed_tools") return { mode: toolChoice.mode === "required" ? "required" : "auto" };
	}
	return { mode: "auto" };
}
