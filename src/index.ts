/**
 * pi-responses-api — serves the Pi coding agent through an OpenAI Responses API compatible HTTP endpoint.
 *
 *   /responses-server start [--port N] [--host H] [--api-key K] [--model provider/id] [--tools a,b]
 *   /responses-server stop | restart | status
 *   pi --responses-server            start automatically with the session
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type RunningServer, startServer } from "./app.ts";
import { parseCommandArgs, type ServerConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";

/** One server per process, shared across extension reloads and nested sessions. */
const STATE_KEY = Symbol.for("pi-responses-api.state");

interface GlobalState {
	server?: RunningServer;
	starting?: Promise<RunningServer>;
	lastOverrides?: Partial<ServerConfig>;
}

function globalState(): GlobalState {
	const holder = globalThis as unknown as Record<symbol, GlobalState | undefined>;
	holder[STATE_KEY] ??= {};
	return holder[STATE_KEY] as GlobalState;
}

export default function responsesApiExtension(pi: ExtensionAPI) {
	const state = globalState();
	let ownsServer = false;
	let latestCtx: ExtensionContext | undefined;

	pi.registerFlag("responses-server", {
		description: "Start the OpenAI Responses API server when the session starts",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("responses-port", { description: "Port for the Responses API server", type: "string" });
	pi.registerFlag("responses-host", { description: "Host/interface for the Responses API server", type: "string" });

	/** Terminal UI gets notifications; headless modes (RPC, print) log to stderr. */
	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		const ctx = latestCtx;
		if (ctx?.mode === "tui" && ctx.hasUI) ctx.ui.notify(message, level);
		else console.error(`[responses-api] ${level === "info" ? "" : `${level}: `}${message}`);
	};

	const updateStatus = () => {
		const ctx = latestCtx;
		if (ctx?.mode !== "tui" || !ctx.hasUI) return;
		const server = state.server;
		ctx.ui.setStatus("responses-api", server ? `⇄ ${server.url}` : undefined);
	};

	const start = async (overrides: Partial<ServerConfig>): Promise<RunningServer> => {
		if (state.server) return state.server;
		if (state.starting) return state.starting;
		const cwd = latestCtx?.cwd ?? process.cwd();
		state.lastOverrides = overrides;
		state.starting = startServer({
			overrides,
			defaultCwd: cwd,
			sink: (level, message) => {
				// Request-level debug logging would flood the terminal UI.
				if (level === "debug" && latestCtx?.mode === "tui") return;
				notify(message, level === "error" ? "error" : "info");
			},
		});
		try {
			state.server = await state.starting;
			ownsServer = true;
			return state.server;
		} finally {
			state.starting = undefined;
			updateStatus();
		}
	};

	const stop = async () => {
		const server = state.server;
		state.server = undefined;
		ownsServer = false;
		if (server) await server.stop();
		updateStatus();
	};

	const flagOverrides = (): Partial<ServerConfig> => {
		const overrides: Partial<ServerConfig> = {};
		const port = pi.getFlag("responses-port");
		const host = pi.getFlag("responses-host");
		if (typeof port === "string" && port) overrides.port = Number.parseInt(port, 10);
		if (typeof host === "string" && host) overrides.host = host;
		return overrides;
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		updateStatus();
		if (pi.getFlag("responses-server") === true && !state.server && !state.starting) {
			try {
				const server = await start(flagOverrides());
				notify(`Responses API server listening on ${server.url}`);
			} catch (error) {
				notify(`Failed to start Responses API server: ${errorMessage(error)}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async (event) => {
		// Keep the server across /reload, /new and /resume; stop it when Pi exits.
		if (ownsServer && (event as { reason?: string }).reason === "quit") await stop();
	});

	pi.registerCommand("responses-server", {
		description: "Control the OpenAI Responses API server: start | stop | restart | status",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "restart", "status"]
				.filter((action) => action.startsWith(prefix))
				.map((action) => ({ value: action, label: action })),
		handler: async (args, ctx) => {
			latestCtx = ctx;
			let parsed: ReturnType<typeof parseCommandArgs>;
			try {
				parsed = parseCommandArgs(args);
			} catch (error) {
				notify(errorMessage(error), "error");
				return;
			}
			const { action, overrides } = parsed;
			try {
				switch (action) {
					case "start": {
						if (state.server) {
							notify(`Already running on ${state.server.url}`, "info");
							return;
						}
						const server = await start({ ...flagOverrides(), ...overrides });
						notify(`Responses API server listening on ${server.url}`, "info");
						return;
					}
					case "stop":
						if (!state.server) {
							notify("Responses API server is not running", "info");
							return;
						}
						await stop();
						notify("Responses API server stopped", "info");
						return;
					case "restart": {
						const previous = state.lastOverrides ?? {};
						await stop();
						const server = await start({ ...previous, ...overrides });
						notify(`Responses API server restarted on ${server.url}`, "info");
						return;
					}
					case "status": {
						const server = state.server;
						if (!server) {
							notify("Responses API server is not running. Use /responses-server start", "info");
							return;
						}
						const { config } = server;
						notify(
							[
								`Responses API: ${server.url}`,
								`auth: ${config.apiKeys.length > 0 ? "bearer token" : "none"}`,
								`active responses: ${server.engine.activeCount}`,
								`tools: ${config.tools?.join(", ") ?? "Pi defaults"}`,
								`data: ${config.dataDir}`,
							].join("\n"),
							"info",
						);
						return;
					}
					default:
						notify(`Unknown action '${action}'. Use start, stop, restart or status.`, "warning");
				}
			} catch (error) {
				notify(`responses-server ${action} failed: ${errorMessage(error)}`, "error");
			} finally {
				updateStatus();
			}
		},
	});
}
