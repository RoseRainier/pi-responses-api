# pi-responses-api

[Pi](https://pi.dev) コーディングエージェントを **OpenAI Responses API 互換**の HTTP エンドポイントとして公開する Pi 拡張です。

公式 `openai` SDK、Vercel AI SDK、各種エージェントフレームワーク、`curl` など、Responses API を話すクライアントならどれからでも Pi にリクエストを送れます。各リクエストは Pi のエージェントターンとして実行され、Pi のモデル設定・認証情報・ツール（`read` / `bash` / `edit` / `write` など）・スキル・コンテキストファイル・他の拡張がそのまま使われます。

[English README](README.md)

## 対応機能

| Responses API の機能 | 対応 |
|---|---|
| `POST /v1/responses`（JSON / SSE ストリーミング） | ✅ `response.created` 〜 `response.completed` の全イベント |
| `instructions`、system / developer メッセージ | ✅ リクエスト単位で適用（OpenAI と同様に次へ引き継がない） |
| `previous_response_id` | ✅ Pi セッションを継続。古いレスポンスからの分岐はセッションツリーの分岐になる |
| `conversation` と Conversations API（アイテムの CRUD 含む） | ✅ |
| `store: false`、全履歴を毎回送るステートレスなクライアント | ✅ |
| Function calling（`type: "function"`）と `function_call_output` | ✅ ステートフル／ステートレス両対応 |
| カスタムツール（`type: "custom"`） | ✅ |
| `tool_choice`（`auto` / `none` / `required` / 関数指定 / `allowed_tools`）、`parallel_tool_calls` | ✅ |
| Structured Outputs（`json_schema` / `json_object`） | ✅ |
| `reasoning.effort`（Pi の thinking level に対応）、`reasoning.summary` | ✅ reasoning アイテムとストリーミング |
| `include: ["reasoning.encrypted_content"]` | ✅ 思考署名を不透明データとして往復 |
| `background: true`、ポーリング、`?stream=true&starting_after=N` での再接続、キャンセル | ✅ |
| `GET` / `DELETE /v1/responses/{id}`、`input_items` 一覧 | ✅ カーソルページング |
| `POST /v1/responses/input_tokens` | ✅ 推定値 |
| `POST /v1/responses/compact` と `compaction` 入力アイテム | ✅ Pi の要約機能を使用 |
| 画像（`input_image`）・ファイル（`input_file`）の data URL / http(s) URL | ✅ テキストはインライン展開、バイナリは保存してエージェントに読ませる |
| `max_output_tokens`、`temperature`、`top_p` | ✅ プロバイダが対応していれば反映 |
| `max_tool_calls`、`metadata`、`user`、`safety_identifier`、`prompt_cache_key` | ✅ |
| `prompt: {id, variables}` | ✅ Pi のプロンプトテンプレートで解決 |
| `GET /v1/models` | ✅ Pi で使えるモデル＋`pi` エイリアス |
| OpenAI ホステッドツール（`web_search` など） | ➖ 警告付きで無視（Pi 自身のツールで処理） |
| `file_id` 参照 / Files API | ❌ インラインで送ってください |
| `logprobs` | ➖ 常に空配列 |

### Pi の概念との対応

- **Pi のツール**はサーバー側で実行され、`output` には `server_label: "pi"` の `mcp_call` アイテムとして現れます（`toolCallItems: "hidden"` で非表示）。
- **クライアントの function ツール**はサーバーでは実行しません。モデルが呼ぶとレスポンスは `function_call` アイテム付きで完了し、エージェントは `function_call_output` が届くまで一時停止します（`previous_response_id` で送るか、ステートレスなら全履歴に含めて送る）。
- **セッション**：保存された会話は通常の Pi セッションファイルなので `pi --resume` で開けます。
- **モデル**：`model` には `pi` / `default`（Pi の既定モデル）、`provider/model`（例 `openai-codex/gpt-5.5`）、モデル ID、`modelAliases` の別名が使えます。

## インストール

Pi と Node.js 22.6 以上が必要です。

```bash
pi install git:github.com/RoseRainier/pi-responses-api   # git で公開後
pi install npm:pi-responses-api                      # npm で公開後
pi install ./pi-responses-api                        # ローカル
pi -e ./pi-responses-api                             # インストールせず1回だけ試す
```

## 使い方

### 対話モードの Pi から

```text
/responses-server start                 # http://127.0.0.1:8321/v1
/responses-server start --port 9000
/responses-server status
/responses-server stop
```

起動中はフッターに `⇄ http://127.0.0.1:8321/v1` が表示されます。起動時に自動で立ち上げる場合：

```bash
pi --responses-server --responses-port 9000
```

### ヘッドレス（常駐）

```bash
npx pi-responses-server --port 8321 --cwd ~/projects/my-app
pi-responses-server --installed --port 8321   # Pi にインストール済みの場合
```

### 呼び出し例

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8321/v1", apiKey: "unused" });
const r = await client.responses.create({ model: "pi", input: "このリポジトリの README を要約して" });
console.log(r.output_text);
```

その他の例は [`examples/`](examples/) を参照してください。

### Pi 独自のリクエストフィールド

| フィールド | 意味 |
|---|---|
| `pi_tools: ["read","grep"]` | このレスポンスで使う Pi ツールを絞る（サーバーの許可範囲内） |
| `tools: [{type:"mcp", server_label:"pi", allowed_tools:["read"]}]` | 同上を MCP ツールとして指定 |
| `pi_cwd: "/path"` | 新規セッションの作業ディレクトリ（`allowCwdOverride` 有効時のみ） |

レスポンスには `x_pi`（`session_id`、`session_file`、`cost_usd`、`warnings`）が付きます。

## 設定

既定値 ← `~/.pi/agent/responses-api.json`（または `$PI_RESPONSES_CONFIG`）← 環境変数 ← コマンド／フラグの順に上書きされます。全項目は [README.md の Configuration](README.md#configuration) と [`examples/responses-api.json`](examples/responses-api.json) を参照してください。

## セキュリティ

エージェントは**あなたの権限で**シェルコマンド実行やファイル編集ができます。エンドポイントに到達できる人も同じことができます。

- 既定では `127.0.0.1` にのみバインドし、それ以外のアドレスは `apiKeys` 未設定なら起動を拒否します。
- 信頼できない呼び出し元には `"tools": ["read", "grep", "find", "ls"]` や `"tools": []` でツールを制限してください。
- ヘッドレス運用はコンテナやサンドボックス内での実行を推奨します。

## 制限事項

- OpenAI のホステッドツールは無視されます（Pi のツールが代わりに働きます）。
- reasoning / compaction の `encrypted_content` は不透明ですが**暗号化はしていません**（base64 の JSON）。
- `input_tokens` は推定値です。
- クライアント関数呼び出しで一時停止したレスポンスは `clientToolTimeoutMs` の間メモリ上で待機します。サーバー再起動後も保存済みセッションから会話を継続できます。
- `max_output_tokens` などはプロバイダ依存です（例：ChatGPT サブスクリプションの Codex エンドポイントは `max_output_tokens` 非対応）。

## 開発

```bash
npm install
npm run typecheck
npm test                                  # オフラインのユニットテスト
./bin/pi-responses-server.mjs --port 18321 &
RESPONSES_BASE_URL=http://127.0.0.1:18321/v1 npm run test:e2e   # 実モデルを呼ぶ E2E
```

## ライセンス

[Apache-2.0](LICENSE)
