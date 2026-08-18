/**
 * Map common argument-name mistakes (file_path, old_string, cmd, ...) onto the
 * canonical built-in tool schemas before validation. Only fills missing canonical
 * keys; never overwrites. Mutates and returns the input object.
 */
type Input = Record<string, unknown>;

const PATH_ALIASES = ["file_path", "filePath", "filename", "file"];
const PATH_TOOLS = new Set(["read", "edit", "write", "ls"]);
const EDIT_PAIRS: Array<[string, string]> = [
	["old_string", "new_string"],
	["old_str", "new_str"],
	["old_text", "new_text"],
	["oldText", "newText"],
	["search", "replace"],
];

/** Copy the first present alias into `key` when `key` is missing. */
function alias(input: Input, key: string, aliases: string[]): void {
	if (input[key] !== undefined) return;
	const found = aliases.find((name) => input[name] !== undefined);
	if (found !== undefined) input[key] = input[found];
}

function normalizeEditItem(item: unknown): unknown {
	if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
	const edit = item as Input;
	for (const [oldKey, newKey] of EDIT_PAIRS) {
		if (edit.oldText === undefined && edit[oldKey] !== undefined) edit.oldText = edit[oldKey];
		if (edit.newText === undefined && edit[newKey] !== undefined) edit.newText = edit[newKey];
	}
	return edit;
}

/** Normalize aliases for one built-in tool. Non-object input is returned unchanged. */
export function normalizeToolArgs(toolName: string, input: Input): Input {
	if (PATH_TOOLS.has(toolName)) alias(input, "path", PATH_ALIASES);
	switch (toolName) {
		case "bash":
			alias(input, "command", ["cmd", "script"]);
			break;
		case "write":
			alias(input, "content", ["text", "contents", "file_content"]);
			break;
		case "read":
			alias(input, "offset", ["start_line", "startLine"]);
			alias(input, "limit", ["line_count", "num_lines", "lines"]);
			break;
		case "edit": {
			if (input.edits === undefined) {
				// Canonical top-level oldText/newText is folded by the edit tool itself.
				const pair = EDIT_PAIRS.find(
					([oldKey, newKey]) => oldKey !== "oldText" && input[oldKey] !== undefined && input[newKey] !== undefined,
				);
				if (pair) input.edits = [{ oldText: input[pair[0]], newText: input[pair[1]] }];
			} else if (Array.isArray(input.edits)) {
				input.edits = input.edits.map(normalizeEditItem);
			}
			break;
		}
	}
	return input;
}

/** `prepareArguments` for a built-in tool: alias normalization on object inputs. */
export function prepareArgumentsWithAliases<T>(toolName: string): (args: unknown) => T {
	return (args) =>
		(args && typeof args === "object" && !Array.isArray(args)
			? normalizeToolArgs(toolName, args as Input)
			: args) as T;
}
