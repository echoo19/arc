import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * How much earlier reasoning is replayed to the model within one turn.
 *
 * Qwen's chat template keeps every assistant step's reasoning that follows the
 * last user message, so a long tool loop accumulates thinking tokens in the
 * prompt. Dropping the reasoning of earlier steps costs almost nothing in KV
 * cache terms (only the previous step's tool call and result are re-prefilled)
 * and can free thousands of tokens on a small context window.
 *
 * - "all": replay everything (Qwen's default behaviour).
 * - "last": keep reasoning only on the most recent assistant message.
 * - "none": never replay reasoning.
 * - "auto": "all" while context usage is below `AUTO_THRESHOLD_PERCENT`, then "last".
 */
export type ReplayThinkingMode = "all" | "last" | "none" | "auto";

export const AUTO_THRESHOLD_PERCENT = 50;

export function replayThinkingMode(value: string | undefined = process.env.ARC_REPLAY_THINKING): ReplayThinkingMode {
	const normalized = value?.trim().toLowerCase();
	return normalized === "all" || normalized === "last" || normalized === "none" ? normalized : "auto";
}

/**
 * Returns a copy of `messages` with thinking blocks removed according to
 * `mode`, or undefined when nothing needs to change. `contextPercent` is the
 * current context usage (0-100) used by "auto".
 */
export function pruneReplayedThinking(
	messages: AgentMessage[],
	mode: ReplayThinkingMode,
	contextPercent: number | null | undefined,
): AgentMessage[] | undefined {
	const effective = mode === "auto" ? ((contextPercent ?? 0) >= AUTO_THRESHOLD_PERCENT ? "last" : "all") : mode;
	if (effective === "all") return undefined;

	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			lastAssistant = i;
			break;
		}
	}

	let changed = false;
	const pruned = messages.map((message, index) => {
		if (message.role !== "assistant") return message;
		if (effective === "last" && index === lastAssistant) return message;
		if (!message.content.some((block) => block.type === "thinking")) return message;
		changed = true;
		return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
	});
	return changed ? pruned : undefined;
}
