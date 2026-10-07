import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// A session-local provider decorator, like jp-gate. Loading it into a shared
// runtime would wrap another session's decorator and record usage in both.
export default function providerWrapper(pi: ExtensionAPI): void {
	let wrapper: Provider | undefined;
	let previous: Provider | undefined;
	let registry: ExtensionContext["modelRegistry"] | undefined;
	const install = (_event: unknown, ctx: ExtensionContext) => {
		registry = ctx.modelRegistry;
		if (wrapper && registry.getRegisteredNativeProvider("fixture") === wrapper) return;
		const original = registry.getProvider("fixture");
		if (!original) throw new Error("Fixture provider missing");
		previous = registry.getRegisteredNativeProvider("fixture");
		const streamSimple: Provider["streamSimple"] = (model, context, options) => {
			pi.appendEntry("fixture-provider-use", {});
			return decorate(original.streamSimple(model, context, options));
		};
		wrapper = new Proxy(original, {
			get(target, key) {
				if (key === "streamSimple") return streamSimple;
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		pi.registerProvider(wrapper);
	};
	pi.on("session_start", install);
	pi.on("before_agent_start", install);
	pi.on("session_shutdown", () => {
		if (registry?.getRegisteredNativeProvider("fixture") !== wrapper) return;
		pi.unregisterProvider("fixture");
		if (previous) pi.registerProvider(previous);
	});
}

function decorate(source: AssistantMessageEventStream): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		// Drain events as well as awaiting the result, just as a stream decorator does.
		for await (const _event of source) { /* consume */ }
		const result = await source.result();
		const message = { ...result, content: result.content.map((part) =>
			part.type === "text" ? { ...part, text: `gated(${part.text})` } : part) };
		output.push({ type: "done", reason: "stop", message });
		output.end();
	})();
	return output;
}
