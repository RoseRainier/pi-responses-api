import { randomBytes } from "node:crypto";

/** Generates an OpenAI-style opaque identifier such as `resp_0f53...`. */
export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}
