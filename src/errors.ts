/** Error that serializes to the OpenAI error envelope: `{ error: { message, type, param, code } }`. */
export class ApiError extends Error {
	readonly status: number;
	readonly type: string;
	readonly param: string | null;
	readonly code: string | null;

	constructor(status: number, message: string, options: { type?: string; param?: string | null; code?: string | null } = {}) {
		super(message);
		this.status = status;
		this.type = options.type ?? (status >= 500 ? "server_error" : "invalid_request_error");
		this.param = options.param ?? null;
		this.code = options.code ?? null;
	}

	toJSON() {
		return { error: { message: this.message, type: this.type, param: this.param, code: this.code } };
	}
}

export function badRequest(message: string, param?: string, code?: string): ApiError {
	return new ApiError(400, message, { param, code });
}

export function notFound(message: string, param?: string): ApiError {
	return new ApiError(404, message, { param, code: "not_found" });
}

export function toApiError(error: unknown): ApiError {
	if (error instanceof ApiError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new ApiError(500, message, { code: "server_error" });
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
