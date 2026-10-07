import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.ts";
import { SessionPool, type SessionHandle } from "../src/sessions.ts";

test("provider decorators stay isolated across new, resumed, concurrent, and disposed sessions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-responses-sessions-"));
	const agentDir = join(root, "agent");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await copyFile(fileURLToPath(new URL("./fixtures/provider-wrapper.ts", import.meta.url)),
		join(agentDir, "extensions/provider-wrapper.ts"));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({
		retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false },
	}));
	const errors: string[] = [];
	const runtimes: ModelRuntime[] = [];
	const createModelRuntime = async () => {
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
		});
		runtime.registerProvider("fixture", {
			api: "fixture-api", apiKey: "local-fixture", baseUrl: "http://unused.invalid",
			models: [{ id: "draft", name: "Draft", reasoning: false, input: ["text"],
				contextWindow: 32768, maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			streamSimple: (model) => draftStream(model),
		});
		await runtime.getAvailable();
		runtimes.push(runtime);
		return runtime;
	};
	const catalog = await createModelRuntime();
	const model = catalog.getModel("fixture", "draft")!;
	const deps = { config: defaultConfig(agentDir), agentDir, createModelRuntime,
		log: (level: string, message: string) => { if (level === "error") errors.push(message); } };
	const pool = new SessionPool(deps);
	let ephemeral: SessionHandle | undefined;
	const prompt = async (handle: SessionHandle) => {
		await handle.session.prompt("test");
		assert.equal(handle.session.getLastAssistantText(), "gated(draft)");
	};
	const usage = (handle: SessionHandle) => handle.session.sessionManager.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "fixture-provider-use").length;
	try {
		const options = { cwd: root, persist: true, ephemeral: false, model, thinkingLevel: "off" as const };
		const first = await pool.create(options);
		await prompt(first);
		const second = await pool.create(options);
		await prompt(second);
		const third = await pool.create(options);
		await prompt(third);
		assert.deepEqual([usage(first), usage(second), usage(third)], [1, 1, 1]);
		assert.equal(catalog.getRegisteredNativeProvider("fixture"), undefined);
		assert.equal(new Set(runtimes).size, 4);

		await prompt(first);
		assert.deepEqual([usage(first), usage(second), usage(third)], [2, 1, 1]);
		await Promise.all([prompt(first), prompt(second), prompt(third)]);
		assert.deepEqual([usage(first), usage(second), usage(third)], [3, 2, 2]);

		await pool.dispose(second);
		await Promise.all([prompt(first), prompt(third)]);
		assert.deepEqual([usage(first), usage(third)], [4, 3]);

		ephemeral = await pool.create({ ...options, persist: false, ephemeral: true });
		await prompt(ephemeral);
		assert.equal(usage(ephemeral), 1);
		await pool.release(ephemeral);
		ephemeral = undefined;
		await prompt(first);
		assert.deepEqual([usage(first), usage(third)], [5, 3]);

		const file = first.session.sessionFile!;
		await pool.dispose(first);
		const reopened = await pool.openFile(file, root);
		await prompt(reopened);
		assert.equal(usage(reopened), 6);
		await prompt(third);
		assert.equal(usage(third), 4);
		assert.deepEqual(errors, []);
	} finally {
		if (ephemeral) await pool.dispose(ephemeral);
		await pool.disposeAll();
		await rm(root, { recursive: true, force: true });
	}
});

function draftStream(model: Model<string>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [{ type: "text", text: "draft" }], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end();
	return stream;
}
