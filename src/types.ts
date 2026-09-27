/**
 * Wire shapes of the OpenAI Responses API that this server reads and writes.
 *
 * The types are intentionally loose: request bodies come from arbitrary clients and
 * unknown fields must round-trip instead of failing type checks.
 */

// biome-ignore lint/suspicious/noExplicitAny: wire data
export type Json = any;

export type ResponseStatus = "queued" | "in_progress" | "completed" | "incomplete" | "failed" | "cancelled";

export interface ResponseUsage {
	input_tokens: number;
	input_tokens_details: { cached_tokens: number };
	output_tokens: number;
	output_tokens_details: { reasoning_tokens: number };
	total_tokens: number;
}

export interface ResponseError {
	code: string;
	message: string;
}

export interface ResponseObject {
	id: string;
	object: "response";
	created_at: number;
	completed_at: number | null;
	status: ResponseStatus;
	background: boolean;
	error: ResponseError | null;
	incomplete_details: { reason: string } | null;
	instructions: string | Json[] | null;
	max_output_tokens: number | null;
	max_tool_calls: number | null;
	model: string;
	output: OutputItem[];
	parallel_tool_calls: boolean;
	previous_response_id: string | null;
	conversation: { id: string } | null;
	prompt: Json | null;
	prompt_cache_key: string | null;
	reasoning: { effort: string | null; summary: string | null };
	safety_identifier: string | null;
	service_tier: string;
	store: boolean;
	temperature: number | null;
	text: { format: Json; verbosity: string | null };
	tool_choice: Json;
	tools: Json[];
	top_logprobs: number | null;
	top_p: number | null;
	truncation: string;
	usage: ResponseUsage | null;
	user: string | null;
	metadata: Record<string, string>;
	/** Pi specific diagnostics. Clients ignore unknown fields. */
	x_pi?: {
		session_id?: string;
		session_file?: string;
		cost_usd?: number;
		warnings?: string[];
	};
}

/** Any item in `input`, `output`, a conversation or `input_items`. */
export interface Item {
	type: string;
	id?: string;
	[key: string]: Json;
}

export type OutputItem = Item;

export interface StreamEvent {
	type: string;
	sequence_number: number;
	[key: string]: Json;
}

/** Normalized `POST /v1/responses` parameters. */
export interface CreateResponseParams {
	model?: string;
	input?: string | Json[];
	instructions?: string | null;
	previous_response_id?: string | null;
	conversation?: string | { id: string } | null;
	store?: boolean;
	stream?: boolean;
	background?: boolean;
	tools?: Json[];
	tool_choice?: Json;
	parallel_tool_calls?: boolean;
	max_output_tokens?: number | null;
	max_tool_calls?: number | null;
	temperature?: number | null;
	top_p?: number | null;
	top_logprobs?: number | null;
	reasoning?: { effort?: string | null; summary?: string | null; generate_summary?: string | null } | null;
	text?: { format?: Json; verbosity?: string | null } | null;
	truncation?: "auto" | "disabled" | null;
	metadata?: Record<string, string> | null;
	include?: string[] | null;
	user?: string | null;
	safety_identifier?: string | null;
	prompt_cache_key?: string | null;
	prompt?: { id: string; version?: string; variables?: Record<string, Json> } | null;
	service_tier?: string | null;
	stream_options?: Json;
	/** Pi extension: restrict the Pi tools that the agent may use for this response. */
	pi_tools?: string[] | null;
	/** Pi extension: working directory for a new session (requires `allowCwdOverride`). */
	pi_cwd?: string | null;
	[key: string]: Json;
}

/** Pi thinking levels (mirrors `ThinkingLevel` from `@earendil-works/pi-agent-core`). */
export type ThinkingLevel = NonNullable<import("@earendil-works/pi-coding-agent").CreateAgentSessionOptions["thinkingLevel"]>;
