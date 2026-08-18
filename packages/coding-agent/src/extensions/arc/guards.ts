import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export { normalizeToolArgs } from "../../core/tools/arg-aliases.ts";

/**
 * Detects a model stuck re-issuing the same tool call. A repeated (name, args)
 * pair is only a loop when it keeps producing the same result: re-running the
 * tests after each edit is fine, re-running them three times with the identical
 * failure is not. The third identical call whose two predecessors returned the
 * same result is blocked; a call is also blocked outright once it has been made
 * `hardLimit` times regardless of results.
 */
export class LoopGuard {
	private calls: Map<string, { count: number; lastResult: string | undefined; sameResultStreak: number }>;
	private pending: Map<string, string>;
	private hardLimit: number;

	constructor(hardLimit: number = 6) {
		this.calls = new Map();
		this.pending = new Map();
		this.hardLimit = hardLimit;
	}

	reset(): void {
		this.calls.clear();
		this.pending.clear();
	}

	/** Records the call and returns a block reason when it looks like a loop. */
	check(name: string, input: unknown, toolCallId?: string): string | undefined {
		const key = `${name} ${JSON.stringify(input)}`;
		const entry = this.calls.get(key) ?? { count: 0, lastResult: undefined, sameResultStreak: 0 };
		entry.count++;
		this.calls.set(key, entry);
		if (toolCallId) this.pending.set(toolCallId, key);
		const previous = entry.count - 1;
		if (previous >= 2 && entry.sameResultStreak >= 2) {
			return `Loop guard: this exact ${name} call was already made ${previous} times in this task with the same arguments and returned the same result each time. Do not repeat it. Use the result you already have, change the arguments or approach, or if the task is complete reply with a short summary.`;
		}
		if (previous >= this.hardLimit) {
			return `Loop guard: this exact ${name} call was already made ${previous} times in this task with the same arguments. Do not repeat it; change the arguments or approach, or if the task is complete reply with a short summary.`;
		}
		return undefined;
	}

	/** Records the result of a call previously passed to check(). */
	record(toolCallId: string, resultText: string): void {
		const key = this.pending.get(toolCallId);
		if (!key) return;
		this.pending.delete(toolCallId);
		const entry = this.calls.get(key);
		if (!entry) return;
		entry.sameResultStreak = entry.lastResult === resultText ? entry.sameResultStreak + 1 : 1;
		entry.lastResult = resultText;
	}
}

/**
 * True when the run ended with an assistant message that stopped normally but
 * produced neither text nor tool calls, which small models do when they
 * "think" and then emit nothing.
 */
export function endedEmpty(messages: AgentMessage[]): boolean {
	const last = lastAssistant(messages);
	if (!last || last.stopReason !== "stop") return false;
	return !last.content.some(
		(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
	);
}

/** Final sentence announces an action ("Let me create the file", "Now I'll run the tests") instead of doing it. */
const ANNOUNCED_ACTION =
	/(^|[.!?\n]\s*)(?:now,? |next,? |first,? |then,? |so,? )?(let me|let's|i(?:'ll| will| am going to|'m going to| need to| should))\b[^.!?\n]{0,160}[.:]?\s*$/i;

/**
 * True when the run stopped normally with text that only announces the next
 * step and no tool call followed it, which small models do instead of acting.
 */
export function endedWithAnnouncedAction(messages: AgentMessage[]): boolean {
	const last = lastAssistant(messages);
	if (!last || last.stopReason !== "stop") return false;
	if (last.content.some((block) => block.type === "toolCall")) return false;
	const text = last.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text.length > 0 && text.length < 600 && ANNOUNCED_ACTION.test(text);
}

/**
 * True when the run stopped because the response hit the output limit without
 * a single tool call: the model wrote a whole file (or its reasoning) as text.
 */
export function endedTruncatedWithoutTools(messages: AgentMessage[]): boolean {
	const last = lastAssistant(messages);
	if (!last || last.stopReason !== "length") return false;
	return !last.content.some((block) => block.type === "toolCall");
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}
