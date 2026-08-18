import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createReadTool } from "../src/core/tools/read.ts";

describe("built-in tools accept common argument aliases", () => {
	it("read maps file_path/start_line/num_lines before validation", () => {
		const tool = createReadTool(process.cwd());
		const prepared = tool.prepareArguments?.({ file_path: "a.txt", start_line: 3, num_lines: 2 });
		expect(prepared).toMatchObject({ path: "a.txt", offset: 3, limit: 2 });
	});

	it("bash maps cmd to command", () => {
		const tool = createBashTool(process.cwd());
		expect(tool.prepareArguments?.({ cmd: "ls" })).toMatchObject({ command: "ls" });
	});

	it("edit maps old_string/new_string into edits[] and keeps canonical input intact", () => {
		const tool = createEditTool(process.cwd());
		expect(tool.prepareArguments?.({ file_path: "a.txt", old_string: "x", new_string: "y" })).toEqual({
			path: "a.txt",
			file_path: "a.txt",
			old_string: "x",
			new_string: "y",
			edits: [{ oldText: "x", newText: "y" }],
		});
		expect(tool.prepareArguments?.({ path: "a.txt", edits: [{ oldText: "x", newText: "y" }] })).toEqual({
			path: "a.txt",
			edits: [{ oldText: "x", newText: "y" }],
		});
	});
});
