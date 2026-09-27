import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Item, Json, ResponseObject } from "./types.ts";

/** Where a response left its Pi session, so that `previous_response_id` can continue from it. */
export interface SessionPointer {
	/** Pool key: the session file, or `mem:<id>` for in-memory sessions. */
	key: string;
	sessionId: string;
	file?: string;
	cwd: string;
	/** Session tree leaf after the response finished (or suspended). */
	leafId: string | null;
	/** Function calls that the response handed to the client and that are still unanswered. */
	pendingCalls?: Array<{ call_id: string; name: string; kind: "function" | "custom" }>;
}

export interface StoredResponse {
	response: ResponseObject;
	inputItems: Item[];
	session?: SessionPointer;
}

export interface StoredConversation {
	id: string;
	object: "conversation";
	created_at: number;
	metadata: Record<string, string>;
	items: Item[];
	/** Items added through the Conversations API that the Pi session has not seen yet. */
	unsyncedItemIds: string[];
	session?: SessionPointer;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * JSON file store for responses and conversations with an in-memory cache.
 * Passing `undefined` as directory keeps everything in memory.
 */
export class Store {
	private readonly responses = new Map<string, StoredResponse>();
	private readonly conversations = new Map<string, StoredConversation>();
	/** Item id → owner, for `item_reference` inputs. */
	private readonly itemOwners = new Map<string, { responseId?: string; conversationId?: string }>();
	private readonly dir: string | undefined;

	constructor(dir: string | undefined) {
		this.dir = dir;
		if (!dir) return;
		mkdirSync(join(dir, "responses"), { recursive: true });
		mkdirSync(join(dir, "conversations"), { recursive: true });
		this.loadItemIndex();
	}

	get directory(): string | undefined {
		return this.dir;
	}

	// ---- responses ----

	getResponse(id: string): StoredResponse | undefined {
		if (!SAFE_ID.test(id)) return undefined;
		const cached = this.responses.get(id);
		if (cached) return cached;
		const loaded = this.readJson<StoredResponse>("responses", id);
		if (loaded) this.responses.set(id, loaded);
		return loaded;
	}

	saveResponse(record: StoredResponse): void {
		const id = record.response.id;
		this.responses.set(id, record);
		this.writeJson("responses", id, record);
		this.indexItems([...record.inputItems, ...record.response.output], { responseId: id });
	}

	deleteResponse(id: string): boolean {
		const existed = this.getResponse(id) !== undefined;
		this.responses.delete(id);
		this.removeJson("responses", id);
		return existed;
	}

	// ---- conversations ----

	getConversation(id: string): StoredConversation | undefined {
		if (!SAFE_ID.test(id)) return undefined;
		const cached = this.conversations.get(id);
		if (cached) return cached;
		const loaded = this.readJson<StoredConversation>("conversations", id);
		if (loaded) this.conversations.set(id, loaded);
		return loaded;
	}

	saveConversation(record: StoredConversation): void {
		this.conversations.set(record.id, record);
		this.writeJson("conversations", record.id, record);
		this.indexItems(record.items, { conversationId: record.id });
	}

	deleteConversation(id: string): boolean {
		const existed = this.getConversation(id) !== undefined;
		this.conversations.delete(id);
		this.removeJson("conversations", id);
		return existed;
	}

	// ---- items ----

	/** Finds a stored item by id for `item_reference` inputs. */
	findItem(id: string): Item | undefined {
		const owner = this.itemOwners.get(id);
		if (!owner) return undefined;
		if (owner.responseId) {
			const record = this.getResponse(owner.responseId);
			const item = record && [...record.inputItems, ...record.response.output].find((candidate) => candidate.id === id);
			if (item) return item;
		}
		if (owner.conversationId) {
			return this.getConversation(owner.conversationId)?.items.find((candidate) => candidate.id === id);
		}
		return undefined;
	}

	private indexItems(items: Item[], owner: { responseId?: string; conversationId?: string }): void {
		const lines: string[] = [];
		for (const item of items) {
			if (!item.id) continue;
			const existing = this.itemOwners.get(item.id);
			if (existing && existing.responseId === owner.responseId && existing.conversationId === owner.conversationId) continue;
			const merged = { ...existing, ...owner };
			this.itemOwners.set(item.id, merged);
			lines.push(JSON.stringify({ id: item.id, ...merged }));
		}
		if (this.dir && lines.length > 0) appendFileSync(join(this.dir, "items.jsonl"), `${lines.join("\n")}\n`);
	}

	private loadItemIndex(): void {
		if (!this.dir) return;
		const path = join(this.dir, "items.jsonl");
		if (!existsSync(path)) return;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { id: string; responseId?: string; conversationId?: string };
				this.itemOwners.set(entry.id, { responseId: entry.responseId, conversationId: entry.conversationId });
			} catch {
				// Ignore a torn trailing line.
			}
		}
	}

	// ---- files ----

	private path(kind: string, id: string): string {
		return join(this.dir as string, kind, `${id}.json`);
	}

	private readJson<T>(kind: string, id: string): T | undefined {
		if (!this.dir) return undefined;
		const path = this.path(kind, id);
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as T;
		} catch {
			return undefined;
		}
	}

	private writeJson(kind: string, id: string, value: Json): void {
		if (!this.dir) return;
		const path = this.path(kind, id);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(value));
		renameSync(tmp, path);
	}

	private removeJson(kind: string, id: string): void {
		if (!this.dir) return;
		rmSync(this.path(kind, id), { force: true });
	}
}
