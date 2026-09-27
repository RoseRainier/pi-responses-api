#!/usr/bin/env node
// Runs Pi headless (RPC mode) with the Responses API server enabled.
//
//   pi-responses-server [--port 8321] [--host 127.0.0.1] [--api-key KEY] [--cwd DIR]
//                       [--model provider/id] [--tools read,bash] [--log-level info|debug]
//                       [--installed | --standalone] [-- <extra pi args>]
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENV_OPTIONS = {
	"--port": "PI_RESPONSES_PORT",
	"--host": "PI_RESPONSES_HOST",
	"--api-key": "PI_RESPONSES_API_KEY",
	"--cwd": "PI_RESPONSES_CWD",
	"--model": "PI_RESPONSES_DEFAULT_MODEL",
	"--tools": "PI_RESPONSES_TOOLS",
	"--data-dir": "PI_RESPONSES_DATA_DIR",
	"--log-level": "PI_RESPONSES_LOG_LEVEL",
	"--cors": "PI_RESPONSES_CORS_ORIGINS",
};

function usage() {
	console.log(`Usage: pi-responses-server [options] [-- <extra pi args>]

Options:
  --port <n>            Port (default 8321)
  --host <host>         Interface (default 127.0.0.1; non-loopback requires --api-key)
  --api-key <key>       Require "Authorization: Bearer <key>"
  --cwd <dir>           Working directory for agent sessions (default: current directory)
  --model <p/id>        Default model, e.g. openai-codex/gpt-5.5
  --tools <list>        Pi tools the agent may use, e.g. read,grep,find,ls
  --data-dir <dir>      Where responses and conversations are stored
  --cors <origins>      Comma separated CORS origins ("*" for any)
  --log-level <level>   silent | info | debug
  --installed           Use the copy installed in Pi (default when "pi install" registered it)
  --standalone          Load this checkout with -e even if another copy is installed
  -h, --help            Show this help

Environment: PI_BIN selects the pi executable (default "pi").`);
}

const args = process.argv.slice(2);
const env = { ...process.env };
const extraPiArgs = [];
let installed;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--") {
		extraPiArgs.push(...args.slice(i + 1));
		break;
	}
	if (arg === "-h" || arg === "--help") {
		usage();
		process.exit(0);
	}
	if (arg === "--installed" || arg === "--standalone") {
		installed = arg === "--installed";
		continue;
	}
	const [name, inline] = arg.split(/=(.*)/s, 2);
	const envName = ENV_OPTIONS[name];
	if (!envName) {
		console.error(`Unknown option: ${arg}`);
		usage();
		process.exit(2);
	}
	const value = inline ?? args[++i];
	if (value === undefined) {
		console.error(`Missing value for ${name}`);
		process.exit(2);
	}
	env[envName] = name === "--cwd" ? resolve(value) : value;
}
env.PI_RESPONSES_CWD ??= process.cwd();

/** True when Pi's settings already load this package, in which case -e would register it twice. */
function isInstalledInPi(cwd) {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	for (const file of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
		if (!existsSync(file)) continue;
		try {
			const packages = JSON.parse(readFileSync(file, "utf8")).packages ?? [];
			for (const entry of packages) {
				const source = typeof entry === "string" ? entry : entry?.source;
				if (typeof source === "string" && /pi-responses-api/.test(source)) return true;
			}
		} catch {
			// Ignore unreadable settings; pi reports them itself.
		}
	}
	return false;
}
installed ??= isInstalledInPi(env.PI_RESPONSES_CWD);

const piBin = process.env.PI_BIN || "pi";
const piArgs = ["--mode", "rpc", "--no-session", ...(installed ? [] : ["-e", packageRoot]), "--responses-server", ...extraPiArgs];
const child = spawn(piBin, piArgs, { cwd: env.PI_RESPONSES_CWD, env, stdio: ["pipe", "ignore", "inherit"] });

child.on("error", (error) => {
	console.error(`Failed to start ${piBin}: ${error.message}`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	process.exit(code ?? (signal ? 1 : 0));
});

let stopping = false;
const shutdown = () => {
	if (stopping) return;
	stopping = true;
	// Closing stdin ends RPC mode, which runs session_shutdown and stops the server cleanly.
	child.stdin.end();
	setTimeout(() => child.kill("SIGTERM"), 5_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
