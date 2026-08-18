import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

export interface ToolOutputLimits {
	maxLines: number;
	maxBytes: number;
}

/** Static limits, or a getter that is called on every tool execution (so model switches take effect). */
export type ToolOutputLimitsOption = ToolOutputLimits | (() => ToolOutputLimits);

const MIN_MAX_BYTES = 8 * 1024;
const MIN_MAX_LINES = 300;
// Rough tokens -> bytes for English/code; one tool result gets ~1/8 of the window.
const BYTES_PER_TOKEN = 3.5;
const CONTEXT_SHARE = 8;
const BYTES_PER_LINE_DIVISOR = 64;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Scale tool output caps to the model's context window so a single result
 * cannot eat most of a small window. Without a context window (or above
 * ~128k) the historical defaults apply. Explicit overrides win per field.
 */
export function resolveToolOutputLimits(
	contextWindow: number | undefined,
	overrides?: Partial<ToolOutputLimits>,
): ToolOutputLimits {
	let maxLines = DEFAULT_MAX_LINES;
	let maxBytes = DEFAULT_MAX_BYTES;
	if (contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0) {
		const tokenBudget = contextWindow / CONTEXT_SHARE;
		maxBytes = clamp(Math.round(tokenBudget * BYTES_PER_TOKEN), MIN_MAX_BYTES, DEFAULT_MAX_BYTES);
		maxLines = clamp(Math.round(contextWindow / BYTES_PER_LINE_DIVISOR), MIN_MAX_LINES, DEFAULT_MAX_LINES);
	}
	return {
		maxLines: overrides?.maxLines ?? maxLines,
		maxBytes: overrides?.maxBytes ?? maxBytes,
	};
}

/** Resolve a tool's `outputLimits` option at execute time. */
export function getToolOutputLimits(option: ToolOutputLimitsOption | undefined): ToolOutputLimits {
	if (option === undefined) return { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
	return typeof option === "function" ? option() : option;
}
