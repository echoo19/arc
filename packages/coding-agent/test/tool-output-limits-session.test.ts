import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("AgentSession tool output limits", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-output-limits-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("scales read output with the current model context window and honors settings overrides", async () => {
		const testFile = join(tempDir, "big.txt");
		writeFileSync(testFile, Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n"));

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const baseModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const smallModel = { ...baseModel, contextWindow: 32768 };
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: smallModel,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const readTool = session.agent.state.tools.find((tool) => tool.name === "read")!;
		const small = await readTool.execute("read-small-window", { path: testFile });
		expect(textOf(small)).toContain("[Showing lines 1-512 of 600. Use offset=513 to continue.]");

		// The limits are resolved per execution, so a model switch takes effect without rebuilding tools.
		session.agent.state.model = { ...baseModel, contextWindow: 200_000 };
		const large = await readTool.execute("read-large-window", { path: testFile });
		expect(textOf(large)).toContain("line 600");
		expect(textOf(large)).not.toContain("Use offset=");

		// Explicit settings override the scaled default.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ toolOutput: { maxLines: 100 } }));
		await settingsManager.reload();
		const overridden = await readTool.execute("read-override", { path: testFile });
		expect(textOf(overridden)).toContain("[Showing lines 1-100 of 600. Use offset=101 to continue.]");

		session.dispose();
	});
});
