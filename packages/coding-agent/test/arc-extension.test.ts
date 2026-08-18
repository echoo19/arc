import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "../src/core/extensions/types.ts";
import { isArcActive } from "../src/extensions/arc/activation.ts";
import {
	endedEmpty,
	endedTruncatedWithoutTools,
	endedWithAnnouncedAction,
	LoopGuard,
	normalizeToolArgs,
} from "../src/extensions/arc/guards.ts";
import arcExtension from "../src/extensions/arc/index.ts";
import {
	isToolStep,
	QWEN_SAMPLING,
	rewriteArcPayload,
	stepThinkingLevelFromEnv,
} from "../src/extensions/arc/payload.ts";
import { buildArcSystemPrompt } from "../src/extensions/arc/prompt.ts";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "qwen3.6-35b-a3b",
		name: "Qwen",
		api: "openai-completions",
		provider: "local",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
		...overrides,
	};
}

function assistant(content: unknown[], stopReason = "stop"): AgentMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: 0,
	} as AgentMessage;
}

describe("arc activation", () => {
	it("activates for local providers and qwen ids on openai-completions", () => {
		expect(isArcActive(model(), undefined)).toBe(true);
		expect(isArcActive(model({ provider: "llama.cpp", id: "gemma" }), undefined)).toBe(true);
		expect(
			isArcActive(
				model({ provider: "vllm", id: "Qwen/Qwen3-Coder", baseUrl: "http://localhost:8000/v1" }),
				undefined,
			),
		).toBe(true);
		expect(
			isArcActive(
				model({ provider: "openrouter", id: "qwen/qwen3-coder", baseUrl: "https://openrouter.ai/api/v1" }),
				undefined,
			),
		).toBe(false);
		expect(isArcActive(model({ provider: "openai", id: "gpt-5" }), undefined)).toBe(false);
		expect(isArcActive(model({ api: "anthropic-messages" }), undefined)).toBe(false);
		expect(isArcActive(undefined, undefined)).toBe(false);
	});

	it("honours ARC_PROFILE", () => {
		expect(isArcActive(model(), "0")).toBe(false);
		expect(isArcActive(model(), "off")).toBe(false);
		expect(isArcActive(model({ provider: "openai", id: "gpt-5" }), "1")).toBe(true);
		expect(isArcActive(model({ provider: "openai", id: "gpt-5" }), "on")).toBe(true);
		expect(isArcActive(model({ api: "anthropic-messages" }), "on")).toBe(false);
	});
});

describe("buildArcSystemPrompt", () => {
	const options = {
		cwd: "C:\\work\\proj",
		selectedTools: ["read", "bash", "edit"],
		toolSnippets: { read: "Read a file", bash: "Run a command", edit: "Edit a file" },
		promptGuidelines: ["Use edit for precise changes"],
		contextFiles: [{ path: "AGENTS.md", content: "Be terse." }],
	};

	it("lists tools, keeps the rules, and appends project context and cwd", () => {
		const prompt = buildArcSystemPrompt(options, "linux");
		expect(prompt).toContain("- read: Read a file");
		expect(prompt).toContain("- edit: Edit a file");
		expect(prompt).toContain("Never repeat a tool call with identical arguments");
		expect(prompt).not.toContain("- Use edit for precise changes");
		expect(prompt).toContain('<project_instructions path="AGENTS.md">\nBe terse.');
		expect(prompt).toContain("Current working directory: C:/work/proj");
		expect(prompt).not.toContain("Pi documentation");
		expect(prompt).not.toContain("Git Bash");
	});

	it("adds the Git Bash note on Windows", () => {
		expect(buildArcSystemPrompt(options, "win32")).toContain("Git Bash on Windows");
	});

	it("stays compact", () => {
		const prompt = buildArcSystemPrompt({ ...options, contextFiles: [] }, "win32");
		// ~4 chars per token; 500 tokens budget (upstream default is ~700 plus a ~280-token docs block).
		expect(prompt.length).toBeLessThan(500 * 4);
	});
});

describe("rewriteArcPayload", () => {
	const base = () => ({
		model: "qwen3.6-35b-a3b",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 8192,
		store: false,
		tools: [{ type: "function", function: { name: "read", parameters: {}, strict: false } }],
	});

	it("ignores non chat payloads", () => {
		expect(rewriteArcPayload({ input: [] }, "medium")).toBeUndefined();
		expect(rewriteArcPayload("x", "medium")).toBeUndefined();
	});

	it("disables thinking and applies instant sampling when off", () => {
		const payload = base();
		const result = rewriteArcPayload(payload, "off") as Record<string, unknown>;
		expect(result).toBe(payload);
		expect(result.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: false });
		expect(result.thinking_budget_tokens).toBeUndefined();
		expect(result.temperature).toBe(QWEN_SAMPLING.instant.temperature);
		expect(result.top_p).toBe(QWEN_SAMPLING.instant.top_p);
		expect(result.top_k).toBe(20);
		expect(result.min_p).toBe(0);
		expect(result.presence_penalty).toBeUndefined();
		expect("store" in result).toBe(false);
		expect((result.tools as Array<{ function: Record<string, unknown> }>)[0]?.function).toEqual({
			name: "read",
			parameters: {},
		});
	});

	it("treats undefined level as off", () => {
		const result = rewriteArcPayload(base(), undefined) as Record<string, unknown>;
		expect(result.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: false });
	});

	it("enables thinking with a clamped budget and thinking sampling", () => {
		const result = rewriteArcPayload(base(), "medium") as Record<string, unknown>;
		expect(result.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: false });
		expect(result.thinking_budget_tokens).toBe(3072);
		expect(result.temperature).toBe(QWEN_SAMPLING.thinking.temperature);
		expect(result.top_p).toBe(QWEN_SAMPLING.thinking.top_p);

		const high = rewriteArcPayload({ ...base(), max_tokens: 4096 }, "high") as Record<string, unknown>;
		expect(high.thinking_budget_tokens).toBe(3072);
		const tiny = rewriteArcPayload({ ...base(), max_tokens: 512 }, "max") as Record<string, unknown>;
		expect(tiny.thinking_budget_tokens).toBe(256);
		const noMax = rewriteArcPayload({ ...base(), max_tokens: undefined }, "max") as Record<string, unknown>;
		expect(noMax.thinking_budget_tokens).toBe(7168);
	});

	it("keeps existing values from samplingParams and chat_template_kwargs", () => {
		const payload = {
			...base(),
			temperature: 0.2,
			presence_penalty: 1.5,
			thinking_budget_tokens: 100,
			chat_template_kwargs: { foo: "bar", enable_thinking: false },
		};
		const result = rewriteArcPayload(payload, "low") as Record<string, unknown>;
		expect(result.temperature).toBe(0.2);
		expect(result.presence_penalty).toBe(1.5);
		expect(result.thinking_budget_tokens).toBe(100);
		expect(result.top_p).toBe(QWEN_SAMPLING.thinking.top_p);
		expect(result.chat_template_kwargs).toEqual({ foo: "bar", enable_thinking: true, preserve_thinking: false });
	});
});

describe("step thinking level", () => {
	it("parses ARC_STEP_THINKING", () => {
		expect(stepThinkingLevelFromEnv(undefined)).toBeUndefined();
		expect(stepThinkingLevelFromEnv("bogus")).toBeUndefined();
		expect(stepThinkingLevelFromEnv(" Low ")).toBe("low");
		expect(stepThinkingLevelFromEnv("off")).toBe("off");
	});

	it("detects tool steps from the wire messages", () => {
		expect(isToolStep([{ role: "user" }])).toBe(false);
		expect(isToolStep([{ role: "user" }, { role: "assistant" }, { role: "tool" }])).toBe(true);
		expect(isToolStep([{ role: "user" }, { role: "assistant" }, { role: "tool" }, { role: "user" }])).toBe(false);
	});

	it("uses the step level mid tool loop and the turn level otherwise", () => {
		const turn = { messages: [{ role: "user" }], max_tokens: 8192 };
		expect((rewriteArcPayload(turn, "high", "low") as Record<string, unknown>).thinking_budget_tokens).toBe(6144);
		const step = { messages: [{ role: "user" }, { role: "assistant" }, { role: "tool" }], max_tokens: 8192 };
		expect((rewriteArcPayload(step, "high", "low") as Record<string, unknown>).thinking_budget_tokens).toBe(1024);
		const fresh = () => ({ messages: [{ role: "user" }, { role: "assistant" }, { role: "tool" }], max_tokens: 8192 });
		const off = rewriteArcPayload(fresh(), "high", "off") as Record<string, unknown>;
		expect(off.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: false });
		const none = rewriteArcPayload(fresh(), "high", undefined) as Record<string, unknown>;
		expect(none.thinking_budget_tokens).toBe(6144);
	});
});

describe("normalizeToolArgs", () => {
	it("maps path aliases for file tools only", () => {
		expect(normalizeToolArgs("read", { file_path: "a.ts" })).toEqual({ file_path: "a.ts", path: "a.ts" });
		expect(normalizeToolArgs("write", { filename: "a.ts", content: "x" }).path).toBe("a.ts");
		expect(normalizeToolArgs("ls", { file: "src" }).path).toBe("src");
		expect(normalizeToolArgs("grep", { file_path: "a.ts" }).path).toBeUndefined();
	});

	it("never overwrites canonical keys", () => {
		expect(normalizeToolArgs("read", { path: "a", file_path: "b" }).path).toBe("a");
		expect(normalizeToolArgs("bash", { command: "ls", cmd: "pwd" }).command).toBe("ls");
	});

	it("maps bash, write and read aliases", () => {
		expect(normalizeToolArgs("bash", { cmd: "ls" }).command).toBe("ls");
		expect(normalizeToolArgs("bash", { script: "ls" }).command).toBe("ls");
		expect(normalizeToolArgs("write", { path: "a", text: "x" }).content).toBe("x");
		expect(normalizeToolArgs("write", { path: "a", file_content: "x" }).content).toBe("x");
		const read = normalizeToolArgs("read", { path: "a", start_line: 5, num_lines: 10 });
		expect(read.offset).toBe(5);
		expect(read.limit).toBe(10);
	});

	it("builds edits[] from top-level pairs and normalizes items", () => {
		expect(normalizeToolArgs("edit", { path: "a", old_string: "x", new_string: "y" }).edits).toEqual([
			{ oldText: "x", newText: "y" },
		]);
		expect(normalizeToolArgs("edit", { path: "a", search: "x", replace: "y" }).edits).toEqual([
			{ oldText: "x", newText: "y" },
		]);
		// canonical top-level oldText/newText is left to the edit tool's own legacy folding
		expect(normalizeToolArgs("edit", { path: "a", oldText: "x", newText: "y" }).edits).toBeUndefined();
		const items = normalizeToolArgs("edit", {
			path: "a",
			edits: [{ old_str: "x", new_str: "y" }, { oldText: "p", newText: "q" }, "junk"],
		}).edits as unknown[];
		expect(items[0]).toEqual({ old_str: "x", new_str: "y", oldText: "x", newText: "y" });
		expect(items[1]).toEqual({ oldText: "p", newText: "q" });
		expect(items[2]).toBe("junk");
	});
});

describe("LoopGuard", () => {
	it("blocks the third identical call only when the previous two returned the same result", () => {
		const guard = new LoopGuard();
		expect(guard.check("bash", { command: "npm test" }, "c1")).toBeUndefined();
		guard.record("c1", "1 failing");
		expect(guard.check("edit", { path: "a" }, "c2")).toBeUndefined();
		guard.record("c2", "ok");
		expect(guard.check("bash", { command: "npm test" }, "c3")).toBeUndefined();
		guard.record("c3", "all passing"); // result changed: re-running tests after an edit is fine
		expect(guard.check("bash", { command: "npm test" }, "c4")).toBeUndefined();
		guard.record("c4", "all passing"); // now two identical results in a row
		expect(guard.check("bash", { command: "npm test" }, "c5")).toContain("returned the same result");
		guard.reset();
		expect(guard.check("bash", { command: "npm test" }, "c6")).toBeUndefined();
	});

	it("blocks a repeated failing edit and applies a hard limit regardless of results", () => {
		const guard = new LoopGuard(4);
		for (const id of ["e1", "e2"]) {
			expect(guard.check("edit", { path: "a", edits: [] }, id)).toBeUndefined();
			guard.record(id, "Could not find the exact text");
		}
		expect(guard.check("edit", { path: "a", edits: [] }, "e3")).toContain("already made 2 times");
		const other = new LoopGuard(4);
		for (let i = 0; i < 4; i++) {
			expect(other.check("read", { path: "a" }, `r${i}`)).toBeUndefined();
			other.record(`r${i}`, `content ${i}`);
		}
		expect(other.check("read", { path: "a" }, "r4")).toContain("already made 4 times");
	});
});

describe("endedWithAnnouncedAction", () => {
	it("detects a final text that only announces the next step", () => {
		const text = (s: string) => [assistant([{ type: "text", text: s }])];
		expect(endedWithAnnouncedAction(text("I read the files. Now let me create the module and run the tests."))).toBe(
			true,
		);
		expect(endedWithAnnouncedAction(text("Next, I'll update the callers:"))).toBe(true);
		expect(
			endedWithAnnouncedAction(
				text("Done. Added PUT and DELETE handlers and verified with node --test (6 passing)."),
			),
		).toBe(false);
		expect(endedWithAnnouncedAction(text("The bug was in tokenizer.js line 40; fixed and all tests pass."))).toBe(
			false,
		);
		expect(
			endedWithAnnouncedAction([
				assistant([
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", id: "1", name: "read", arguments: {} },
				]),
			]),
		).toBe(false);
	});
});

describe("endedTruncatedWithoutTools", () => {
	it("detects a length stop without tool calls", () => {
		expect(endedTruncatedWithoutTools([assistant([{ type: "text", text: "code..." }], "length")])).toBe(true);
		expect(
			endedTruncatedWithoutTools([
				assistant([{ type: "toolCall", id: "1", name: "write", arguments: {} }], "length"),
			]),
		).toBe(false);
		expect(endedTruncatedWithoutTools([assistant([{ type: "text", text: "done" }], "stop")])).toBe(false);
	});
});

describe("endedEmpty", () => {
	it("detects a stop with no text and no tool calls", () => {
		expect(endedEmpty([assistant([])])).toBe(true);
		expect(endedEmpty([assistant([{ type: "text", text: "  \n" }])])).toBe(true);
		expect(endedEmpty([assistant([{ type: "thinking", thinking: "hmm" }])])).toBe(true);
		expect(endedEmpty([assistant([{ type: "text", text: "done" }])])).toBe(false);
		expect(endedEmpty([assistant([{ type: "toolCall", id: "1", name: "read", arguments: {} }])])).toBe(false);
		expect(endedEmpty([assistant([], "error")])).toBe(false);
		expect(endedEmpty([])).toBe(false);
	});
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function loadExtension() {
	const handlers = new Map<string, Handler>();
	const sendUserMessage = vi.fn();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		sendUserMessage,
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	arcExtension(api);
	const ctxFor = (m: Model<Api> | undefined, thinkingLevel = "medium") =>
		({ model: m, thinkingLevel, cwd: "/tmp" }) as unknown as ExtensionContext;
	return { handlers, sendUserMessage, ctxFor };
}

describe("arc extension hooks", () => {
	const startEvent: BeforeAgentStartEvent = {
		type: "before_agent_start",
		prompt: "go",
		systemPrompt: "base",
		systemPromptOptions: { cwd: "/tmp", selectedTools: ["read"], toolSnippets: { read: "Read" } },
	};

	it("does nothing when inactive", async () => {
		const { handlers, sendUserMessage, ctxFor } = loadExtension();
		const ctx = ctxFor(model({ provider: "openai", id: "gpt-5" }));
		expect(await handlers.get("before_agent_start")!(startEvent, ctx)).toBeUndefined();
		const payload = { messages: [], store: false };
		expect(await handlers.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx)).toBe(
			undefined,
		);
		expect(payload.store).toBe(false);
		const input: Record<string, unknown> = { cmd: "ls" };
		const toolEvent = { type: "tool_call", toolName: "bash", toolCallId: "1", input } as ToolCallEvent;
		expect(await handlers.get("tool_call")!(toolEvent, ctx)).toBeUndefined();
		expect(input).toEqual({ cmd: "ls" });
		await handlers.get("agent_end")!({ type: "agent_end", messages: [assistant([])] } as AgentEndEvent, ctx);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("replaces the system prompt unless the user set a custom one", async () => {
		const { handlers, ctxFor } = loadExtension();
		const ctx = ctxFor(model());
		const result = (await handlers.get("before_agent_start")!(startEvent, ctx)) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("- read: Read");
		expect(result.systemPrompt).toContain("Current working directory: /tmp");
		const custom = {
			...startEvent,
			systemPromptOptions: { ...startEvent.systemPromptOptions, customPrompt: "mine" },
		};
		expect(await handlers.get("before_agent_start")!(custom, ctx)).toBeUndefined();
	});

	it("rewrites the payload using the context thinking level", async () => {
		const { handlers, ctxFor } = loadExtension();
		const payload: Record<string, unknown> = { messages: [], store: false, max_tokens: 8192 };
		await handlers.get("before_provider_request")!(
			{ type: "before_provider_request", payload },
			ctxFor(model(), "low"),
		);
		expect(payload.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: false });
		expect(payload.thinking_budget_tokens).toBe(1024);
		expect("store" in payload).toBe(false);
	});

	it("normalizes args, defaults bash timeout, and blocks loops per prompt", async () => {
		const { handlers, ctxFor } = loadExtension();
		const ctx = ctxFor(model());
		let id = 0;
		const call = async (input: Record<string, unknown>, result = "same output") => {
			const toolCallId = String(++id);
			const outcome = await handlers.get("tool_call")!(
				{ type: "tool_call", toolName: "bash", toolCallId, input } as ToolCallEvent,
				ctx,
			);
			if (!outcome) {
				await handlers.get("tool_result")!(
					{
						type: "tool_result",
						toolName: "bash",
						toolCallId,
						input,
						content: [{ type: "text", text: result }],
					} as ToolResultEvent,
					ctx,
				);
			}
			return outcome;
		};
		const first: Record<string, unknown> = { cmd: "ls" };
		expect(await call(first)).toBeUndefined();
		expect(first).toEqual({ cmd: "ls", command: "ls", timeout: 120 });
		expect(await call({ cmd: "ls", timeout: 5 })).toBeUndefined();
		expect(await call({ cmd: "ls" })).toBeUndefined();
		const blocked = (await call({ cmd: "ls" })) as { block: boolean; reason: string };
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("Loop guard: this exact bash call was already made 2 times");
		await handlers.get("before_agent_start")!(startEvent, ctx);
		expect(await call({ cmd: "ls" })).toBeUndefined();
	});

	it("nudges at most twice per prompt when the model stops empty", async () => {
		const { handlers, sendUserMessage, ctxFor } = loadExtension();
		const ctx = ctxFor(model());
		const end = { type: "agent_end", messages: [assistant([])] } as AgentEndEvent;
		await handlers.get("agent_end")!(end, ctx);
		await handlers.get("agent_end")!(end, ctx);
		await handlers.get("agent_end")!(end, ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
		expect(sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("Continue with the task"), {
			deliverAs: "followUp",
		});
		await handlers.get("agent_end")!(
			{ type: "agent_end", messages: [assistant([{ type: "text", text: "ok" }])] },
			ctx,
		);
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
		await handlers.get("before_agent_start")!(startEvent, ctx);
		await handlers.get("agent_end")!(end, ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(3);
	});
});
