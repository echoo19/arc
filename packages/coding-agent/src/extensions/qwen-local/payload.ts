import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type QwenSamplingParams = { temperature: number; top_p: number; top_k: number; min_p: number };

/** Qwen3 recommended sampling. Applied only for keys absent from the payload, so models.json samplingParams win. */
export const QWEN_SAMPLING: { thinking: QwenSamplingParams; instant: QwenSamplingParams } = {
	thinking: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
	instant: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 },
};
// presence_penalty is intentionally not defaulted; Qwen suggests 0-2 to curb repetition (set via samplingParams).

/** Reasoning budget per level; clamped so the answer keeps at least 1024 tokens of max_tokens. */
export const QWEN_THINKING_BUDGET: Record<Exclude<ThinkingLevel, "off">, number> = {
	minimal: 512,
	low: 1024,
	medium: 3072,
	high: 6144,
	xhigh: 8192,
	max: 8192,
};

const DEFAULT_MAX_TOKENS = 8192;
const MIN_THINKING_BUDGET = 256;

type Payload = Record<string, unknown> & { messages: unknown[] };

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Optional thinking level for tool steps (assistant turns that follow a tool
 * result rather than a user message), from PI_QWEN_STEP_THINKING. Lets the
 * model think hard once when a user turn starts and briefly on each step.
 */
export function stepThinkingLevelFromEnv(
	value: string | undefined = process.env.PI_QWEN_STEP_THINKING,
): ThinkingLevel | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized && THINKING_LEVELS.has(normalized) ? (normalized as ThinkingLevel) : undefined;
}

/** True when the last non-tool message in the request is an assistant message, i.e. we are mid tool loop. */
export function isToolStep(messages: unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = asRecord(messages[i])?.role;
		if (role === "tool") continue;
		return role === "assistant";
	}
	return false;
}

function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && Array.isArray((value as { messages?: unknown }).messages);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Rewrite an openai-completions request body for a llama.cpp-served Qwen model:
 * thinking toggle via chat_template_kwargs, per-level thinking budget, Qwen
 * sampling defaults, and removal of fields llama.cpp ignores. Mutates and
 * returns the same object; returns `undefined` for anything that is not a
 * chat-completions payload.
 */
export function rewriteQwenPayload(
	payload: unknown,
	thinkingLevel: ThinkingLevel | undefined,
	stepThinkingLevel: ThinkingLevel | undefined = stepThinkingLevelFromEnv(),
): unknown {
	if (!isPayload(payload)) return undefined;
	const level =
		stepThinkingLevel !== undefined && isToolStep(payload.messages) ? stepThinkingLevel : (thinkingLevel ?? "off");
	const thinking = level !== "off";

	payload.chat_template_kwargs = {
		...asRecord(payload.chat_template_kwargs),
		enable_thinking: thinking,
		preserve_thinking: false,
	};

	if (level !== "off" && payload.thinking_budget_tokens === undefined) {
		const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : DEFAULT_MAX_TOKENS;
		payload.thinking_budget_tokens = Math.max(
			MIN_THINKING_BUDGET,
			Math.min(QWEN_THINKING_BUDGET[level], maxTokens - 1024),
		);
	}

	const sampling = thinking ? QWEN_SAMPLING.thinking : QWEN_SAMPLING.instant;
	for (const [key, value] of Object.entries(sampling)) {
		if (payload[key] === undefined) payload[key] = value;
	}

	delete payload.store;
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			const fn = asRecord(asRecord(tool)?.function);
			if (fn) delete fn.strict;
		}
	}
	return payload;
}
