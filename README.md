# pi-responses-api

A [Pi](https://pi.dev) extension that serves the Pi coding agent through an **OpenAI Responses API** compatible HTTP endpoint.

Any client that speaks the Responses API — the official `openai` SDKs, the Vercel AI SDK, agent frameworks, `curl` — can send requests to Pi. Each request runs a full Pi agent turn: Pi's model routing, credentials, tools (`read`, `bash`, `edit`, `write`, …), skills, context files and your other extensions all apply.

[日本語の README はこちら](README.ja.md)

```text
 OpenAI SDK / curl / any Responses client
                 │  POST /v1/responses  (JSON or SSE)
                 ▼
   ┌─────────────────────────────┐
   │ pi-responses-api (extension) │
   │   HTTP server + event mapper │
   └──────────────┬──────────────┘
                  ▼
     Pi AgentSession (per conversation)
     models · tools · skills · sessions
```

## Features

| Responses API feature | Support |
|---|---|
| `POST /v1/responses` — text, JSON and SSE streaming (`stream: true`) | ✅ Full event sequence (`response.created` … `response.completed`) |
| `instructions`, system/developer messages | ✅ Applied per request (not carried over, as in OpenAI) |
| `previous_response_id` | ✅ Continues the Pi session; branching from older responses creates a session tree branch |
| `conversation` + Conversations API (`/v1/conversations`, items CRUD) | ✅ |
| `store: false` / stateless clients that resend the full history | ✅ |
| Function calling (`tools: [{type: "function"}]`), `function_call_output` | ✅ Stateful and stateless |
| Custom tools (`type: "custom"`) | ✅ |
| `tool_choice` (`auto`, `none`, `required`, specific function, `allowed_tools`), `parallel_tool_calls` | ✅ |
| Structured outputs `text.format: json_schema` / `json_object` | ✅ |
| `reasoning.effort` → Pi thinking level, `reasoning.summary` | ✅ Reasoning items, summary/text streaming |
| `include: ["reasoning.encrypted_content"]` | ✅ Opaque round-trip of thinking signatures |
| `background: true`, polling, `GET …?stream=true&starting_after=N`, `POST …/cancel` | ✅ |
| `GET/DELETE /v1/responses/{id}`, `GET …/input_items` | ✅ Cursor pagination |
| `POST /v1/responses/input_tokens` | ✅ Estimate |
| `POST /v1/responses/compact` + `compaction` input items | ✅ Uses Pi's summarizer |
| Images (`input_image`, data or http URLs), files (`input_file` data or http URLs) | ✅ Text files inline, binaries saved for the agent to read |
| `max_output_tokens`, `temperature`, `top_p` | ✅ Passed to the provider where supported |
| `max_tool_calls`, `metadata`, `user`, `safety_identifier`, `prompt_cache_key` | ✅ |
| `prompt: {id, variables}` | ✅ Resolved against Pi prompt templates |
| `GET /v1/models` | ✅ Pi's available models plus the `pi` alias |
| Hosted tools (`web_search`, `file_search`, `code_interpreter`, `computer`, `image_generation`, remote `mcp`) | ➖ Ignored with a warning; Pi's own tools do the work |
| `file_id` references / Files API | ❌ Send files inline instead |
| `logprobs` | ➖ Always empty arrays |

### How Pi concepts map to the API

- **Pi tools** (`read`, `bash`, …) execute on the server. They appear in `output` as `mcp_call` items with `server_label: "pi"` (set `toolCallItems: "hidden"` to omit them). Streaming emits `response.mcp_call.*` events.
- **Client function tools** declared in `tools` are *not* executed by the server. When the model calls one, the response completes with a `function_call` item. The agent stays suspended until you send the `function_call_output` (via `previous_response_id`, or as part of the full history for stateless clients).
- **Sessions**: every stored conversation is a normal Pi session file, so you can open it with `pi --resume`. Set `persistSessions: false` to keep them in memory.
- **Models**: `model` can be `pi`/`default` (Pi's default model), `provider/model` (e.g. `openai-codex/gpt-5.5`), a bare model id, or an alias from `modelAliases`.

## Install

Requires Pi and Node.js ≥ 22.6.

```bash
# from git (after you publish the repository)
pi install git:github.com/RoseRainier/pi-responses-api

# from npm (after you publish the package)
pi install npm:pi-responses-api

# from a local checkout
pi install ./pi-responses-api

# try it for one run without installing
pi -e ./pi-responses-api
```

## Usage

### Inside interactive Pi

```text
/responses-server start                 # http://127.0.0.1:8321/v1
/responses-server start --port 9000
/responses-server status
/responses-server stop
```

The footer shows `⇄ http://127.0.0.1:8321/v1` while the server runs. Or start it with Pi:

```bash
pi --responses-server --responses-port 9000
```

### Headless (daemon)

```bash
npx pi-responses-server --port 8321 --cwd ~/projects/my-app
# or, if the package is already installed in Pi:
pi-responses-server --installed --port 8321
```

This runs Pi in RPC mode with the server enabled. Stop it with Ctrl+C / SIGTERM.

### Calling it

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8321/v1", apiKey: "unused" });

const response = await client.responses.create({
  model: "pi",
  input: "Summarize the README in this repository.",
  reasoning: { effort: "low" },
});
console.log(response.output_text);
```

```bash
curl http://127.0.0.1:8321/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"pi","input":"List the files in the current directory","stream":true}'
```

More examples: [`examples/`](examples/).

### Pi-specific request fields

| Field | Meaning |
|---|---|
| `pi_tools: ["read","grep"]` | Restrict the Pi tools for this response (within the server's allowed set) |
| `tools: [{type:"mcp", server_label:"pi", allowed_tools:["read"]}]` | Same, expressed as an MCP tool |
| `pi_cwd: "/path"` | Working directory for a new session (only if `allowCwdOverride` is enabled) |

Responses carry an extra `x_pi` object (`session_id`, `session_file`, `cost_usd`, `warnings`); disable it with `exposeSessionInfo: false`.

## Configuration

Settings are merged from defaults ← `~/.pi/agent/responses-api.json` (or `$PI_RESPONSES_CONFIG`) ← environment variables ← command/flag options. See [`examples/responses-api.json`](examples/responses-api.json).

| Key | Env | Default | Description |
|---|---|---|---|
| `host` | `PI_RESPONSES_HOST` | `127.0.0.1` | Bind address. Non-loopback requires `apiKeys`. |
| `port` | `PI_RESPONSES_PORT` | `8321` | |
| `apiKeys` | `PI_RESPONSES_API_KEY(S)` | `[]` | Accepted `Authorization: Bearer` tokens (comma separated in env). |
| `allowUnauthenticatedRemote` | | `false` | Allow a non-loopback host without keys. |
| `corsOrigins` | `PI_RESPONSES_CORS_ORIGINS` | `[]` | Allowed browser origins (`*` for any). |
| `cwd` | `PI_RESPONSES_CWD` | Pi's cwd | Working directory of agent sessions. |
| `allowCwdOverride` | | `false` | Allow `pi_cwd` in requests. |
| `tools` | `PI_RESPONSES_TOOLS` | Pi defaults | Pi tools the agent may use, e.g. `["read","grep","find","ls"]`. |
| `toolCallItems` | | `mcp_call` | `mcp_call` or `hidden`. |
| `defaultModel` | `PI_RESPONSES_DEFAULT_MODEL` | Pi default | Model for `pi`/`default`/unknown names. |
| `modelAliases` | | `{}` | e.g. `{"gpt-4o": "anthropic/claude-sonnet-4-5"}` |
| `unknownModel` | | `default` | `default` (fall back) or `error` (404). |
| `persistSessions` | `PI_RESPONSES_PERSIST_SESSIONS` | `true` | Write Pi session files. |
| `sessionDir` | `PI_RESPONSES_SESSION_DIR` | Pi default | Session directory. |
| `dataDir` | `PI_RESPONSES_DATA_DIR` | `~/.pi/agent/responses-api` | Stored responses, conversations, uploads. |
| `loadExtensions` | `PI_RESPONSES_LOAD_EXTENSIONS` | `true` | Load your other Pi extensions into API sessions. |
| `expandPromptTemplates` | | `false` | Expand `/template` and `/skill:` in user input. |
| `clientToolTimeoutMs` | | `600000` | How long a suspended function call waits for output. |
| `sessionIdleTtlMs` | | `900000` | Idle time before a live session is closed (it can be reopened). |
| `maxConcurrentRuns` | | `4` | Parallel responses. |
| `maxBodyBytes` | | `52428800` | Request size limit. |
| `abortOnDisconnect` | | `true` | Cancel a foreground response when the client disconnects. |
| `exposeSessionInfo` | | `true` | Include `x_pi` in responses. |
| `refreshModels` | | `false` | Refresh model catalogs from the network at start. |
| `logLevel` | `PI_RESPONSES_LOG_LEVEL` | `info` | `silent`, `info`, `debug`. |

## Security

The agent can run shell commands and edit files with **your** permissions. Anyone who can reach the endpoint can do the same.

- The server binds to `127.0.0.1` by default and refuses other interfaces unless `apiKeys` is set.
- For untrusted callers restrict tools, e.g. `"tools": ["read", "grep", "find", "ls"]` or `"tools": []`.
- Consider running headless mode inside a container or sandbox (see Pi's containerization docs).

## Limitations

- Pi executes its own tools; OpenAI-hosted tools are ignored.
- `encrypted_content` of reasoning and compaction items is opaque but **not encrypted** — it is base64 JSON for this server.
- `input_tokens` is an estimate.
- A response suspended on client function calls stays live in memory for `clientToolTimeoutMs`. After a restart the conversation still continues from the stored session.
- `max_output_tokens`, `temperature` and `top_p` depend on the provider (for example the ChatGPT-subscription Codex endpoint ignores `max_output_tokens`).

## Development

```bash
npm install
npm run typecheck
npm test                                  # offline unit tests
pi-responses-server --port 18321 &        # or: ./bin/pi-responses-server.mjs
RESPONSES_BASE_URL=http://127.0.0.1:18321/v1 npm run test:e2e   # real model calls
```

Source layout:

| File | Role |
|---|---|
| `extensions/responses-api.ts` | Extension entry point loaded by Pi |
| `src/index.ts` | `/responses-server` command, flags, lifecycle |
| `src/app.ts` | Wires model runtime, store, session pool, engine and HTTP server |
| `src/server.ts` | HTTP routing, auth, CORS, SSE |
| `src/engine.ts` | Response lifecycle, sessions, suspension/resume, conversations, compaction |
| `src/sessions.ts` | Pi `AgentSession` pool and the bridge extension (instructions, payload overrides, client tools) |
| `src/run.ts` | Pi events → Responses output items and streaming events |
| `src/input.ts` | Responses input items → Pi messages |
| `src/payload.ts` | Provider payload overrides (`max_output_tokens`, `tool_choice`, …) |
| `src/store.ts` | JSON file store |

## License

[Apache-2.0](LICENSE)
