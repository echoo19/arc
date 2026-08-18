import { describe, expect, it } from "vitest";
import { getToolOutputLimits, resolveToolOutputLimits } from "../src/core/tools/output-limits.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

describe("resolveToolOutputLimits", () => {
	it("uses the historical defaults without a context window", () => {
		expect(resolveToolOutputLimits(undefined)).toEqual({ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		expect(resolveToolOutputLimits(0)).toEqual({ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	});

	it("scales down for a 32k context window", () => {
		expect(resolveToolOutputLimits(32768)).toEqual({ maxLines: 512, maxBytes: 14336 });
	});

	it("caps at the defaults for large windows", () => {
		expect(resolveToolOutputLimits(128_000)).toEqual({ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		expect(resolveToolOutputLimits(1_000_000)).toEqual({ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	});

	it("never drops below the floor for tiny windows", () => {
		expect(resolveToolOutputLimits(4096)).toEqual({ maxLines: 300, maxBytes: 8192 });
	});

	it("lets explicit overrides win per field", () => {
		expect(resolveToolOutputLimits(32768, { maxBytes: 4000 })).toEqual({ maxLines: 512, maxBytes: 4000 });
		expect(resolveToolOutputLimits(undefined, { maxLines: 100 })).toEqual({
			maxLines: 100,
			maxBytes: DEFAULT_MAX_BYTES,
		});
	});
});

describe("getToolOutputLimits", () => {
	it("returns defaults when unset and calls getters", () => {
		expect(getToolOutputLimits(undefined)).toEqual({ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		expect(getToolOutputLimits({ maxLines: 1, maxBytes: 2 })).toEqual({ maxLines: 1, maxBytes: 2 });
		let calls = 0;
		const getter = () => {
			calls++;
			return { maxLines: 3, maxBytes: 4 };
		};
		expect(getToolOutputLimits(getter)).toEqual({ maxLines: 3, maxBytes: 4 });
		getToolOutputLimits(getter);
		expect(calls).toBe(2);
	});
});
