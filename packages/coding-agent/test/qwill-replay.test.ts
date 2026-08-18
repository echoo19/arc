import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { pruneReplayedThinking, replayThinkingMode } from "../src/extensions/qwill/replay.ts";

function assistant(id: string, withThinking: boolean): AgentMessage {
	return {
		role: "assistant",
		content: [
			...(withThinking
				? [{ type: "thinking", thinking: `think ${id}`, thinkingSignature: "reasoning_content" }]
				: []),
			{ type: "toolCall", id, name: "read", arguments: { path: id } },
		],
		api: "openai-completions",
		provider: "local",
		model: "qwen3.6-35b-a3b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	} as AgentMessage;
}

function toolResult(id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

const user = { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 } as AgentMessage;

const thinkingBlocks = (m: AgentMessage) =>
	m.role === "assistant" ? m.content.filter((b) => b.type === "thinking").length : 0;

describe("replayThinkingMode", () => {
	it("defaults to auto and accepts explicit modes", () => {
		expect(replayThinkingMode(undefined)).toBe("auto");
		expect(replayThinkingMode("bogus")).toBe("auto");
		expect(replayThinkingMode(" NONE ")).toBe("none");
		expect(replayThinkingMode("last")).toBe("last");
		expect(replayThinkingMode("all")).toBe("all");
	});
});

describe("pruneReplayedThinking", () => {
	const messages = [
		user,
		assistant("1", true),
		toolResult("1"),
		assistant("2", true),
		toolResult("2"),
		assistant("3", true),
		toolResult("3"),
	];

	it("leaves everything alone in all mode and below the auto threshold", () => {
		expect(pruneReplayedThinking(messages, "all", 90)).toBeUndefined();
		expect(pruneReplayedThinking(messages, "auto", 20)).toBeUndefined();
		expect(pruneReplayedThinking(messages, "auto", null)).toBeUndefined();
	});

	it("keeps only the latest step's reasoning in last mode and auto above the threshold", () => {
		for (const [mode, percent] of [
			["last", 0],
			["auto", 55],
		] as const) {
			const pruned = pruneReplayedThinking(messages, mode, percent);
			expect(pruned).toBeDefined();
			expect(pruned!.map(thinkingBlocks)).toEqual([0, 0, 0, 0, 0, 1, 0]);
			// original untouched
			expect(messages.map(thinkingBlocks)).toEqual([0, 1, 0, 1, 0, 1, 0]);
			// tool calls survive
			expect((pruned![1] as { content: unknown[] }).content).toHaveLength(1);
		}
	});

	it("drops all reasoning in none mode and reports no change when there is none", () => {
		const pruned = pruneReplayedThinking(messages, "none", 0);
		expect(pruned!.map(thinkingBlocks)).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(pruneReplayedThinking([user, assistant("1", false)], "none", 0)).toBeUndefined();
	});
});
