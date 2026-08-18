import { describe, expect, it } from "vitest";
import { buildBaseOptions, clampMaxTokensToContext } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
		// 10_000 - 1_005 - 625 (scaled safety margin) = 8_370 leaves room for the full 8_000
		expect(buildBaseOptions(model, context).maxTokens).toBe(8_000);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		};

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});
});

describe("clampMaxTokensToContext", () => {
	function withWindow(contextWindow: number, maxTokens: number): Model<"openai-responses"> {
		return { ...model, contextWindow, maxTokens };
	}
	const context: Context = { messages: [createAssistant(100, 20_000)] };

	it("uses a 4096 margin on large windows", () => {
		expect(clampMaxTokensToContext(withWindow(200_000, 100_000), context, 100_000)).toBe(100_000);
		expect(clampMaxTokensToContext(withWindow(200_000, 200_000), context, 200_000)).toBe(200_000 - 20_000 - 4_096);
	});

	it("scales the margin to 1/16 of small windows", () => {
		// 32k window: margin 2048 instead of 4096
		expect(clampMaxTokensToContext(withWindow(32_768, 32_768), context, 32_768)).toBe(32_768 - 20_000 - 2_048);
	});

	it("never drops the margin below 512", () => {
		const small: Context = { messages: [createAssistant(100, 1_000)] };
		expect(clampMaxTokensToContext(withWindow(4_096, 4_096), small, 4_096)).toBe(4_096 - 1_000 - 512);
	});

	it("keeps at least one token and ignores unknown windows", () => {
		expect(clampMaxTokensToContext(withWindow(20_000, 8_000), context, 8_000)).toBe(1);
		expect(clampMaxTokensToContext(withWindow(0, 8_000), context, 8_000)).toBe(8_000);
	});
});
