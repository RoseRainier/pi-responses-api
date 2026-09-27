import type { Item, Json } from "./types.ts";

/** Cursor pagination compatible with the OpenAI list endpoints. */
export function paginate(items: Item[], query: URLSearchParams, defaultOrder: "asc" | "desc"): Json {
	const order = query.get("order") === "asc" ? "asc" : query.get("order") === "desc" ? "desc" : defaultOrder;
	const limit = Math.min(100, Math.max(1, Number.parseInt(query.get("limit") ?? "20", 10) || 20));
	let list = order === "asc" ? [...items] : [...items].reverse();
	const after = query.get("after");
	if (after) {
		const index = list.findIndex((item) => item.id === after);
		list = index >= 0 ? list.slice(index + 1) : list;
	}
	const before = query.get("before");
	if (before) {
		const index = list.findIndex((item) => item.id === before);
		list = index >= 0 ? list.slice(0, index) : list;
	}
	const data = list.slice(0, limit);
	return { object: "list", data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: list.length > limit };
}
