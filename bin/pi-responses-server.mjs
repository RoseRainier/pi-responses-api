#!/usr/bin/env node
// Runs Pi headless (RPC mode) with the Responses API server enabled.
//
//   pi-responses-server [--port 8321] [--host 127.0.0.1] [--api-key KEY] [--cwd DIR]
//                       [--model provider/id] [--tools read,bash] [--log-level info|debug]
//                       [--installed] [-- <extra pi args>]
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
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
  --installed           The package is installed in Pi already; do not pass -e
  -h, --help            Show this help

Environment: PI_BIN selects the pi executable (default "pi").`);
}

const args = process.argv.slice(2);
const env = { ...process.env };
const extraPiArgs = [];
let installed = false;
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
	if (arg === "--installed") {
		installed = true;
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
