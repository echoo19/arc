import { applyPatch } from "diff";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findClosestMatch, fuzzyFindText } from "../src/core/tools/edit-diff.ts";
import { createEditTool } from "../src/index.ts";

const editTool = createEditTool(process.cwd());

describe("edit tool indentation-insensitive matching", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-indent-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("matches spaces in oldText against tabs in the file and keeps the file's tabs", async () => {
		const testFile = join(testDir, "tabs.ts");
		const original = "function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n\treturn 2;\n}\n";
		writeFileSync(testFile, original);

		const result = await editTool.execute("indent-1", {
			path: testFile,
			edits: [
				{
					oldText: "    if (x) {\n        return 1;\n    }\n",
					newText: "    if (x) {\n        return 10;\n    } else {\n        log();\n    }\n",
				},
			],
		});

		const expected = "function f() {\n\tif (x) {\n\t\treturn 10;\n\t} else {\n\t\tlog();\n\t}\n\treturn 2;\n}\n";
		expect(readFileSync(testFile, "utf-8")).toBe(expected);
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(expected);
	});

	it("matches 2-space oldText against a 4-space file and scales nested indentation", async () => {
		const testFile = join(testDir, "spaces.py");
		const original = "def f():\n    if x:\n        return 1\n    return 2\n";
		writeFileSync(testFile, original);

		await editTool.execute("indent-2", {
			path: testFile,
			edits: [
				{
					oldText: "  if x:\n    return 1\n",
					newText: "  if x:\n    y = 1\n    return y\n",
				},
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(
			"def f():\n    if x:\n        y = 1\n        return y\n    return 2\n",
		);
	});

	it("matches unindented oldText and indents every non-blank newText line", async () => {
		const testFile = join(testDir, "unindented.ts");
		writeFileSync(testFile, "class A {\n    run() {\n        a();\n\n        b();\n    }\n}\n");

		await editTool.execute("indent-3", {
			path: testFile,
			edits: [{ oldText: "a();\n\nb();\n", newText: "a();\n\nc();\nb();\n" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe(
			"class A {\n    run() {\n        a();\n\n        c();\n        b();\n    }\n}\n",
		);
	});

	it("keeps the file indentation of the first line when the match starts mid-line", async () => {
		const testFile = join(testDir, "mid-line.ts");
		writeFileSync(testFile, "    const a = 1;\n    const b = 2;\n");

		await editTool.execute("indent-4", {
			path: testFile,
			edits: [{ oldText: "a = 1;\n\tconst b = 2;", newText: "a = 10;\n\tconst b = 20;" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("    const a = 10;\n    const b = 20;\n");
	});

	it("preserves untouched lines byte-for-byte and keeps CRLF endings", async () => {
		const testFile = join(testDir, "crlf.txt");
		writeFileSync(testFile, "keep  \r\n\ttarget\r\nkeep too   \r\n");

		await editTool.execute("indent-5", {
			path: testFile,
			edits: [{ oldText: "  target\n", newText: "  replaced\n" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("keep  \r\n\treplaced\r\nkeep too   \r\n");
	});

	it("reports an ambiguity error when the indent-insensitive match is not unique", async () => {
		const testFile = join(testDir, "ambiguous.ts");
		writeFileSync(testFile, "if (a) {\n    x();\n}\nif (b) {\n        x();\n}\n");

		await expect(
			editTool.execute("indent-6", {
				path: testFile,
				edits: [{ oldText: "\tx();\n", newText: "\ty();\n" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("skips leading blank oldText lines when picking the reference indentation", async () => {
		const testFile = join(testDir, "leading-blank.ts");
		writeFileSync(testFile, "a\n\n    foo\n    bar\n");

		await editTool.execute("indent-8", {
			path: testFile,
			edits: [{ oldText: "\n\tfoo\n\tbar\n", newText: "\n\tfoo2\n\tbar2\n" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("a\n\n    foo2\n    bar2\n");
	});

	it("does not report an exact edit ambiguous because another edit needs the indent tier", async () => {
		const testFile = join(testDir, "mixed.ts");
		writeFileSync(testFile, "if (a) {\n    x();\n}\nif (a) {\n        x();\n}\nfoo\n");

		await editTool.execute("indent-9", {
			path: testFile,
			edits: [
				{ oldText: "if (a) {\n    x();\n", newText: "if (a) {\n    y();\n" },
				{ oldText: "\tfoo\n", newText: "\tbar\n" },
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("if (a) {\n    y();\n}\nif (a) {\n        x();\n}\nbar\n");
	});

	it("uses the indent tier only when exact and fuzzy fail", () => {
		const content = "  foo\n    bar\n";
		expect(fuzzyFindText(content, "  foo\n    bar")?.tier).toBe("exact");
		expect(fuzzyFindText(content, "  foo  \n    bar")?.tier).toBe("fuzzy");
		expect(fuzzyFindText(content, "foo\nbar")?.tier).toBe("indent");
		expect(fuzzyFindText(content, "foo\nbaz")).toBeUndefined();
	});

	it("still fails and preserves the file when even indent-insensitive matching finds nothing", async () => {
		const testFile = join(testDir, "not-found.ts");
		const original = "const a = 1;\n";
		writeFileSync(testFile, original);

		await expect(
			editTool.execute("indent-7", {
				path: testFile,
				edits: [{ oldText: "const zzz = 99;", newText: "x" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(original);
	});
});

describe("edit tool nearest-match hint", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-hint-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("appends the closest matching lines with line numbers to the not-found error", async () => {
		const testFile = join(testDir, "hint.ts");
		writeFileSync(
			testFile,
			[
				"import { x } from './x';",
				"",
				"export function compute(value: number) {",
				"\tconst doubled = value * 2;",
				"\treturn doubled + 1;",
				"}",
				"",
			].join("\n"),
		);

		let message = "";
		try {
			await editTool.execute("hint-1", {
				path: testFile,
				edits: [{ oldText: "\tconst doubled = value * 3;\n\treturn doubled + 1;\n", newText: "\treturn value;\n" }],
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain(`Could not find the exact text in ${testFile}.`);
		expect(message).toContain("Differences in trailing whitespace and indentation are tolerated");
		expect(message).not.toContain("must match exactly");
		expect(message).toContain(`Closest match in ${testFile} at lines 4-6`);
		expect(message).toContain("4: \tconst doubled = value * 2;");
		expect(message).toContain("5: \treturn doubled + 1;");
		expect(message).toContain("6: }");
		expect(message).toContain("Copy the text to replace verbatim from the file (use read), including indentation.");
	});

	it("names the failing edit index for multi-edit calls", async () => {
		const testFile = join(testDir, "hint-multi.ts");
		writeFileSync(testFile, "alpha\nbeta\ngamma\n");

		await expect(
			editTool.execute("hint-2", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamme\n", newText: "GAMMA\n" },
				],
			}),
		).rejects.toThrow(/Could not find edits\[1\] in .*Closest match in .* at lines 3-3.*\n3: gamma/s);
	});

	it("omits the hint when nothing in the file resembles oldText", () => {
		expect(findClosestMatch("completely different content\n", "this does not exist")).toBeUndefined();
	});

	it("caps the snippet size", () => {
		const longLine = "x".repeat(400);
		const content = ["const target = 1;", longLine, longLine, longLine, "end"].join("\n");
		const closest = findClosestMatch(content, `const target = 2;\n${longLine}\n${longLine}\nqux`);
		expect(closest?.startLine).toBe(1);
		expect(closest?.snippet.length).toBeLessThanOrEqual(620);
		expect(closest?.snippet.split("\n").length).toBe(2);
	});
});
