import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "../src/core/extensions/types.ts";
import { isQwenLocalActive } from "../src/extensions/qwen-local/activation.ts";
import { endedEmpty, LoopGuard, normalizeToolArgs } from "../src/extensions/qwen-local/guards.ts";
import qwenLocalExtension from "../src/extensions/qwen-local/index.ts";
import { QWEN_SAMPLING, rewriteQwenPayload } from "../src/extensions/qwen-local/payload.ts";
import { buildQwenSystemPrompt } from "../src/extensions/qwen-local/prompt.ts";

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

describe("qwen-local activation", () => {
	it("activates for local providers and qwen ids on openai-completions", () => {
		expect(isQwenLocalActive(model(), undefined)).toBe(true);
		expect(isQwenLocalActive(model({ provider: "llama.cpp", id: "gemma" }), undefined)).toBe(true);
		expect(
			isQwenLocalActive(
				model({ provider: "vllm", id: "Qwen/Qwen3-Coder", baseUrl: "http://localhost:8000/v1" }),
				undefined,
			),
		).toBe(true);
		expect(
			isQwenLocalActive(
				model({ provider: "openrouter", id: "qwen/qwen3-coder", baseUrl: "https://openrouter.ai/api/v1" }),
				undefined,
			),
		).toBe(false);
		expect(isQwenLocalActive(model({ provider: "openai", id: "gpt-5" }), undefined)).toBe(false);
		expect(isQwenLocalActive(model({ api: "anthropic-messages" }), undefined)).toBe(false);
		expect(isQwenLocalActive(undefined, undefined)).toBe(false);
	});

	it("honours PI_QWEN_PROFILE", () => {
		expect(isQwenLocalActive(model(), "0")).toBe(false);
		expect(isQwenLocalActive(model(), "off")).toBe(false);
		expect(isQwenLocalActive(model({ provider: "openai", id: "gpt-5" }), "1")).toBe(true);
		expect(isQwenLocalActive(model({ provider: "openai", id: "gpt-5" }), "on")).toBe(true);
		expect(isQwenLocalActive(model({ api: "anthropic-messages" }), "on")).toBe(false);
	});
});

describe("buildQwenSystemPrompt", () => {
	const options = {
		cwd: "C:\\work\\proj",
		selectedTools: ["read", "bash", "edit"],
		toolSnippets: { read: "Read a file", bash: "Run a command", edit: "Edit a file" },
		promptGuidelines: ["Use edit for precise changes"],
		contextFiles: [{ path: "AGENTS.md", content: "Be terse." }],
	};

	it("lists tools, keeps the rules, and appends project context and cwd", () => {
		const prompt = buildQwenSystemPrompt(options, "linux");
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
		expect(buildQwenSystemPrompt(options, "win32")).toContain("Git Bash on Windows");
	});

	it("stays compact", () => {
		const prompt = buildQwenSystemPrompt({ ...options, contextFiles: [] }, "win32");
		// ~4 chars per token; 450 tokens budget.
		expect(prompt.length).toBeLessThan(450 * 4);
	});
});

describe("rewriteQwenPayload", () => {
	const base = () => ({
		model: "qwen3.6-35b-a3b",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 8192,
		store: false,
		tools: [{ type: "function", function: { name: "read", parameters: {}, strict: false } }],
	});

	it("ignores non chat payloads", () => {
		expect(rewriteQwenPayload({ input: [] }, "medium")).toBeUndefined();
		expect(rewriteQwenPayload("x", "medium")).toBeUndefined();
	});

	it("disables thinking and applies instant sampling when off", () => {
		const payload = base();
		const result = rewriteQwenPayload(payload, "off") as Record<string, unknown>;
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
		const result = rewriteQwenPayload(base(), undefined) as Record<string, unknown>;
		expect(result.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: false });
	});

	it("enables thinking with a clamped budget and thinking sampling", () => {
		const result = rewriteQwenPayload(base(), "medium") as Record<string, unknown>;
		expect(result.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: false });
		expect(result.thinking_budget_tokens).toBe(3072);
		expect(result.temperature).toBe(QWEN_SAMPLING.thinking.temperature);
		expect(result.top_p).toBe(QWEN_SAMPLING.thinking.top_p);

		const high = rewriteQwenPayload({ ...base(), max_tokens: 4096 }, "high") as Record<string, unknown>;
		expect(high.thinking_budget_tokens).toBe(3072);
		const tiny = rewriteQwenPayload({ ...base(), max_tokens: 512 }, "max") as Record<string, unknown>;
		expect(tiny.thinking_budget_tokens).toBe(256);
		const noMax = rewriteQwenPayload({ ...base(), max_tokens: undefined }, "max") as Record<string, unknown>;
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
		const result = rewriteQwenPayload(payload, "low") as Record<string, unknown>;
		expect(result.temperature).toBe(0.2);
		expect(result.presence_penalty).toBe(1.5);
		expect(result.thinking_budget_tokens).toBe(100);
		expect(result.top_p).toBe(QWEN_SAMPLING.thinking.top_p);
		expect(result.chat_template_kwargs).toEqual({ foo: "bar", enable_thinking: true, preserve_thinking: false });
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
	it("blocks the third identical call and counts the blocked attempt", () => {
		const guard = new LoopGuard();
		expect(guard.check("read", { path: "a" })).toBeUndefined();
		expect(guard.check("read", { path: "b" })).toBeUndefined();
		expect(guard.check("read", { path: "a" })).toBeUndefined();
		// reads get twice the allowance: the third and fourth identical reads still pass
		expect(guard.check("read", { path: "a" })).toBeUndefined();
		expect(guard.check("read", { path: "a" })).toBeUndefined();
		expect(guard.check("read", { path: "a" })).toContain("already made 4 times");
		expect(guard.check("read", { path: "a" })).toContain("already made 5 times");
		expect(guard.check("bash", { command: "ls" })).toBeUndefined();
		expect(guard.check("bash", { command: "ls" })).toBeUndefined();
		expect(guard.check("bash", { command: "ls" })).toContain("already made 2 times");
		guard.reset();
		expect(guard.check("read", { path: "a" })).toBeUndefined();
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
	qwenLocalExtension(api);
	const ctxFor = (m: Model<Api> | undefined, thinkingLevel = "medium") =>
		({ model: m, thinkingLevel, cwd: "/tmp" }) as unknown as ExtensionContext;
	return { handlers, sendUserMessage, ctxFor };
}

describe("qwen-local extension hooks", () => {
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
		const call = async (input: Record<string, unknown>) =>
			handlers.get("tool_call")!(
				{ type: "tool_call", toolName: "bash", toolCallId: "1", input } as ToolCallEvent,
				ctx,
			);
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
