import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { isQwenLocalActive } from "./activation.ts";
import { endedEmpty, LoopGuard, normalizeToolArgs } from "./guards.ts";
import { rewriteQwenPayload } from "./payload.ts";
import { buildQwenSystemPrompt } from "./prompt.ts";

const BASH_DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_NUDGES = 2;
const NUDGE =
	"Continue with the task. If it is already complete, reply with a short summary of what you did and how you verified it.";

/**
 * Built-in profile for Qwen models served locally (llama.cpp): compact system
 * prompt, Qwen sampling and thinking wiring on the request body, tolerant tool
 * argument names, a repeated-call guard, and a nudge when the model stops
 * without producing anything. All hooks are no-ops when the profile is not
 * active for the current model (see isQwenLocalActive).
 */
export default function qwenLocalExtension(pi: ExtensionAPI): void {
	const loopGuard = new LoopGuard();
	let nudges = 0;

	pi.on("before_agent_start", (event, ctx) => {
		if (!isQwenLocalActive(ctx.model)) return undefined;
		loopGuard.reset();
		nudges = 0;
		// Respect an explicit user prompt (--system-prompt / SYSTEM.md).
		if (event.systemPromptOptions.customPrompt) return undefined;
		return { systemPrompt: buildQwenSystemPrompt(event.systemPromptOptions) };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isQwenLocalActive(ctx.model)) return undefined;
		return rewriteQwenPayload(event.payload, ctx.thinkingLevel ?? pi.getThinkingLevel());
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isQwenLocalActive(ctx.model)) return undefined;
		const input = normalizeToolArgs(event.toolName, event.input);
		if (event.toolName === "bash" && input.timeout === undefined) input.timeout = BASH_DEFAULT_TIMEOUT_SECONDS;
		const reason = loopGuard.check(event.toolName, input, event.toolCallId);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isQwenLocalActive(ctx.model)) return undefined;
		const text = event.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n");
		loopGuard.record(event.toolCallId, text);
		return undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		if (!isQwenLocalActive(ctx.model) || nudges >= MAX_NUDGES || !endedEmpty(event.messages)) return;
		nudges++;
		// The run is still active during agent_end, so this queues as a follow-up
		// and the session continues with it instead of going idle.
		pi.sendUserMessage(NUDGE, { deliverAs: "followUp" });
	});
}
