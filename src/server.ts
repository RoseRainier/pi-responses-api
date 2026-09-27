import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.ts";
import type { ResponsesEngine } from "./engine.ts";
import { ApiError, badRequest, notFound, toApiError } from "./errors.ts";
import type { ResponseRun } from "./run.ts";
import type { CreateResponseParams, Json, StreamEvent } from "./types.ts";

type Log = (level: "info" | "debug" | "error", message: string) => void;

interface Route {
	method: string;
	pattern: RegExp;
	handler: (ctx: RequestContext, ...params: string[]) => Promise<void> | void;
}

interface RequestContext {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
	body: () => Promise<Json>;
}

/** HTTP front end: `/v1/responses`, `/v1/conversations`, `/v1/models`, `/health`. */
export class ResponsesHttpServer {
	private server: Server | undefined;
	private readonly routes: Route[];
	private readonly sockets = new Set<import("node:net").Socket>();

	constructor(
		private readonly config: ServerConfig,
		private readonly engine: ResponsesEngine,
		private readonly log: Log,
	) {
		const e = engine;
		this.routes = [
			{ method: "GET", pattern: /^\/health$/, handler: (c) => this.json(c.res, 200, { status: "ok", active_responses: e.activeCount }) },
			{ method: "GET", pattern: /^\/models$/, handler: (c) => this.json(c.res, 200, { object: "list", data: e.listModels() }) },
			{ method: "GET", pattern: /^\/models\/(.+)$/, handler: (c, id) => this.json(c.res, 200, e.getModel(decodeURIComponent(id))) },
			{ method: "POST", pattern: /^\/responses$/, handler: (c) => this.createResponse(c) },
			{ method: "POST", pattern: /^\/responses\/input_tokens$/, handler: async (c) => this.json(c.res, 200, await e.countInputTokens(await c.body())) },
			{ method: "POST", pattern: /^\/responses\/compact$/, handler: async (c) => this.json(c.res, 200, await e.compact(await c.body())) },
			{ method: "GET", pattern: /^\/responses\/([^/]+)$/, handler: (c, id) => this.getResponse(c, id) },
			{ method: "DELETE", pattern: /^\/responses\/([^/]+)$/, handler: (c, id) => this.json(c.res, 200, e.delete(id)) },
			{ method: "POST", pattern: /^\/responses\/([^/]+)\/cancel$/, handler: async (c, id) => this.json(c.res, 200, await e.cancel(id)) },
			{ method: "GET", pattern: /^\/responses\/([^/]+)\/input_items$/, handler: (c, id) => this.json(c.res, 200, e.inputItems(id, c.url.searchParams)) },
			{ method: "POST", pattern: /^\/conversations$/, handler: async (c) => this.json(c.res, 200, e.createConversation(await c.body())) },
			{ method: "GET", pattern: /^\/conversations\/([^/]+)$/, handler: (c, id) => this.json(c.res, 200, e.getConversation(id)) },
			{ method: "POST", pattern: /^\/conversations\/([^/]+)$/, handler: async (c, id) => this.json(c.res, 200, e.updateConversation(id, await c.body())) },
			{ method: "DELETE", pattern: /^\/conversations\/([^/]+)$/, handler: (c, id) => this.json(c.res, 200, e.deleteConversation(id)) },
			{ method: "POST", pattern: /^\/conversations\/([^/]+)\/items$/, handler: async (c, id) => this.json(c.res, 200, e.addConversationItems(id, await c.body())) },
			{ method: "GET", pattern: /^\/conversations\/([^/]+)\/items$/, handler: (c, id) => this.json(c.res, 200, e.listConversationItems(id, c.url.searchParams)) },
			{ method: "GET", pattern: /^\/conversations\/([^/]+)\/items\/([^/]+)$/, handler: (c, id, item) => this.json(c.res, 200, e.getConversationItem(id, item)) },
			{ method: "DELETE", pattern: /^\/conversations\/([^/]+)\/items\/([^/]+)$/, handler: (c, id, item) => this.json(c.res, 200, e.deleteConversationItem(id, item)) },
		];
	}

	get address(): AddressInfo | undefined {
		const address = this.server?.address();
		return address && typeof address === "object" ? address : undefined;
	}

	get url(): string | undefined {
		const address = this.address;
		if (!address) return undefined;
		const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
		return `http://${host}:${address.port}/v1`;
	}

	async listen(): Promise<void> {
		const server = createServer((req, res) => void this.handle(req, res));
		server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.config.port, this.config.host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
	}

	async close(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			for (const socket of this.sockets) socket.destroy();
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const started = Date.now();
		const url = new URL(req.url ?? "/", "http://localhost");
		try {
			this.applyCors(req, res);
			if (req.method === "OPTIONS") {
				res.writeHead(204).end();
				return;
			}
			// Accept both `/v1/...` and bare paths.
			const path = url.pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/|$)/, "") || "/";
			if (path !== "/health") this.authenticate(req);
			let bodyCache: Promise<Json> | undefined;
			const ctx: RequestContext = { req, res, url, body: () => (bodyCache ??= this.readBody(req)) };
			let methodMismatch = false;
			for (const route of this.routes) {
				const match = route.pattern.exec(path);
				if (!match) continue;
				if (route.method !== req.method) {
					methodMismatch = true;
					continue;
				}
				await route.handler(ctx, ...match.slice(1));
				return;
			}
			if (methodMismatch) throw new ApiError(405, `Method ${req.method} not allowed for ${url.pathname}.`);
			throw notFound(`Unknown endpoint: ${req.method} ${url.pathname}`);
		} catch (error) {
			const apiError = toApiError(error);
			if (apiError.status >= 500) this.log("error", `${req.method} ${url.pathname}: ${apiError.message}`);
			if (!res.headersSent) this.json(res, apiError.status, apiError.toJSON());
			else if (!res.writableEnded) res.end();
		} finally {
			this.log("debug", `${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
		}
	}

	private authenticate(req: IncomingMessage): void {
		const keys = this.config.apiKeys;
		if (keys.length === 0) return;
		const header = req.headers.authorization ?? "";
		const token = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.headers["x-api-key"] as string | undefined);
		if (!token || !keys.includes(token)) {
			throw new ApiError(401, "Incorrect API key provided.", { type: "invalid_request_error", code: "invalid_api_key" });
		}
	}

	private applyCors(req: IncomingMessage, res: ServerResponse): void {
		const origins = this.config.corsOrigins;
		const origin = req.headers.origin;
		if (origins.length === 0 || !origin) return;
		if (!origins.includes("*") && !origins.includes(origin)) return;
		res.setHeader("Access-Control-Allow-Origin", origins.includes("*") ? "*" : origin);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "authorization, content-type");
		res.setHeader("Access-Control-Max-Age", "600");
	}

	private async readBody(req: IncomingMessage): Promise<Json> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > this.config.maxBodyBytes) throw new ApiError(413, `Request body exceeds ${this.config.maxBodyBytes} bytes.`);
			chunks.push(chunk as Buffer);
		}
		const text = Buffer.concat(chunks).toString("utf8");
		if (!text.trim()) return {};
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			return parsed;
		} catch {
			throw badRequest("We could not parse the JSON body of your request.");
		}
	}

	private json(res: ServerResponse, status: number, body: Json): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
		res.end(payload);
	}

	// ---- responses ----

	private async createResponse(ctx: RequestContext): Promise<void> {
		const params = (await ctx.body()) as CreateResponseParams;
		const run = await this.engine.create(params);
		const id = run.response.id;
		if (params.stream) {
			this.streamRun(ctx, run, run.events.length > 0 ? [...run.events] : [], params.background !== true);
			return;
		}
		if (params.background) {
			this.json(ctx.res, 200, run.response);
			return;
		}
		const onClose = () => {
			if (!ctx.res.writableEnded && this.config.abortOnDisconnect) this.engine.abandon(id);
		};
		ctx.res.on("close", onClose);
		const response = await run.finished;
		ctx.res.off("close", onClose);
		if (!ctx.res.destroyed) this.json(ctx.res, 200, response);
	}

	private async getResponse(ctx: RequestContext, id: string): Promise<void> {
		const query = ctx.url.searchParams;
		if (query.get("stream") !== "true") {
			this.json(ctx.res, 200, this.engine.get(id));
			return;
		}
		const startingAfter = Number.parseInt(query.get("starting_after") ?? "-1", 10);
		const { events, run } = this.engine.eventSource(id);
		const backlog = events.filter((event) => event.sequence_number > startingAfter);
		if (run) this.streamRun(ctx, run, backlog, false, startingAfter);
		else {
			this.startSse(ctx.res);
			for (const event of backlog) this.writeEvent(ctx.res, event);
			ctx.res.end();
		}
	}

	private startSse(res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.flushHeaders?.();
	}

	private writeEvent(res: ServerResponse, event: StreamEvent): void {
		if (res.writableEnded || res.destroyed) return;
		res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	}

	/** Streams a run: first the backlog, then live events until the terminal event. */
	private streamRun(ctx: RequestContext, run: ResponseRun, backlog: StreamEvent[], abortOnClose: boolean, startingAfter = -1): void {
		const { res } = ctx;
		this.startSse(res);
		let last = startingAfter;
		const write = (event: StreamEvent) => {
			if (event.sequence_number <= last) return;
			last = event.sequence_number;
			this.writeEvent(res, event);
		};
		for (const event of backlog) write(event);
		// Events emitted between `create()` and subscription are in `run.events`.
		for (const event of run.events) write(event);
		if (run.isFinished) {
			res.end();
			return;
		}
		const unsubscribe = run.subscribe(write);
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(": keep-alive\n\n");
		}, 15_000);
		heartbeat.unref?.();
		void run.finished.then(() => {
			clearInterval(heartbeat);
			unsubscribe();
			for (const event of run.events) write(event);
			if (!res.writableEnded) res.end();
		});
		res.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
			if (abortOnClose && !run.isFinished && this.config.abortOnDisconnect) this.engine.abandon(run.response.id);
		});
	}
}
