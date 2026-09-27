import { mkdirSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultAgentDir, loadConfig, type ServerConfig } from "./config.ts";
import { ResponsesEngine } from "./engine.ts";
import { ResponsesHttpServer } from "./server.ts";
import { SessionPool } from "./sessions.ts";
import { Store } from "./store.ts";

export type LogLevel = "info" | "debug" | "error";
export type LogSink = (level: LogLevel, message: string) => void;

export interface RunningServer {
	config: ServerConfig;
	url: string;
	engine: ResponsesEngine;
	stop(): Promise<void>;
}

const LEVELS: Record<ServerConfig["logLevel"], number> = { silent: 0, info: 1, debug: 2 };

export function createLogger(config: ServerConfig, sink: LogSink): LogSink {
	return (level, message) => {
		const threshold = LEVELS[config.logLevel] ?? 1;
		if (level === "debug" && threshold < 2) return;
		if (level === "info" && threshold < 1) return;
		if (level === "error" && threshold < 1) return;
		sink(level, message);
	};
}

/** Builds and starts the whole server: model runtime, session pool, store, engine and HTTP listener. */
export async function startServer(options: {
	overrides?: Partial<ServerConfig>;
	defaultCwd: string;
	sink: LogSink;
	agentDir?: string;
}): Promise<RunningServer> {
	const agentDir = options.agentDir ?? defaultAgentDir();
	const config = loadConfig(options.overrides, agentDir);
	const log = createLogger(config, options.sink);
	mkdirSync(config.dataDir, { recursive: true });

	const modelRuntime = await ModelRuntime.create({ refreshOnCreate: config.refreshModels, modelRefreshTimeoutMs: 10_000 });
	// Resolves credential availability so that the default model and `/models` are known.
	await modelRuntime.getAvailable().catch(() => []);

	const store = new Store(config.dataDir);
	const pool = new SessionPool({ config, modelRuntime, agentDir, log });
	const engine = new ResponsesEngine({ config, store, pool, modelRuntime, defaultCwd: config.cwd ?? options.defaultCwd, log });
	const http = new ResponsesHttpServer(config, engine, log);
	await http.listen();
	const url = http.url ?? `http://${config.host}:${config.port}/v1`;
	log("debug", `Responses API listening on ${url}`);

	let stopped = false;
	return {
		config,
		url,
		engine,
		async stop() {
			if (stopped) return;
			stopped = true;
			await http.close();
			await engine.shutdown();
			await pool.disposeAll();
			log("info", "Responses API stopped");
		},
	};
}
