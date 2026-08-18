/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * Normalize text for indentation-insensitive matching: fuzzy normalization
 * plus stripping the leading whitespace of every line.
 */
export function normalizeForIndentInsensitiveMatch(text: string): string {
	return normalizeForFuzzyMatch(text)
		.split("\n")
		.map((line) => line.trimStart())
		.join("\n");
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** Leading whitespace of a line, not counting its line ending (a blank line yields ""). */
function getLeadingWhitespace(line: string): string {
	return /^[^\S\n]*/.exec(line)?.[0] ?? "";
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

/**
 * Matching tiers, tried in order. Each tier normalizes both the file content
 * and oldText the same way before an `indexOf` search:
 * - exact: no normalization
 * - fuzzy: trailing whitespace, Unicode quotes/dashes/spaces (see normalizeForFuzzyMatch)
 * - indent: fuzzy plus leading whitespace of every line
 */
export type MatchTier = "exact" | "fuzzy" | "indent";

const MATCH_TIERS: MatchTier[] = ["exact", "fuzzy", "indent"];

function normalizeForTier(text: string, tier: MatchTier): string {
	if (tier === "exact") return text;
	if (tier === "fuzzy") return normalizeForFuzzyMatch(text);
	return normalizeForIndentInsensitiveMatch(text);
}

export interface FuzzyMatchResult {
	/** The tier at which oldText was found */
	tier: MatchTier;
	/** The index where the match starts, in the content normalized for `tier` */
	index: number;
	/** Length of the matched text, in the content normalized for `tier` */
	matchLength: number;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match, then
 * indentation-insensitive match. Returns undefined when no tier matches.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult | undefined {
	for (const tier of MATCH_TIERS) {
		const normalizedOldText = normalizeForTier(oldText, tier);
		const index = normalizeForTier(content, tier).indexOf(normalizedOldText);
		if (index !== -1) {
			return { tier, index, matchLength: normalizedOldText.length };
		}
	}
	return undefined;
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * Re-indent newText so that it uses the file's indentation instead of the
 * indentation the model used in oldText. `oldIndent` and `fileIndent` are the
 * leading whitespace of the same reference line in oldText and in the file.
 * Lines from `fromLine` onwards that share `oldIndent` get it swapped for
 * `fileIndent`; when both indents are a single repeated character (all tabs or
 * all spaces) uniform leading whitespace is scaled instead, so nested lines keep
 * their relative depth (two tabs become eight spaces for a four-space file).
 * Other lines are left unchanged.
 */
function reindentText(newText: string, oldIndent: string, fileIndent: string, fromLine: number): string {
	if (oldIndent === fileIndent) return newText;
	const uniform = (ws: string) => ws.length > 0 && ws === ws[0].repeat(ws.length);
	const scalable = uniform(oldIndent) && uniform(fileIndent);
	return newText
		.split("\n")
		.map((line, i) => {
			if (i < fromLine || line.trim().length === 0) return line;
			const leading = getLeadingWhitespace(line);
			const rest = line.slice(leading.length);
			if (scalable && uniform(leading) && leading[0] === oldIndent[0] && leading.length % oldIndent.length === 0) {
				return fileIndent[0].repeat((leading.length / oldIndent.length) * fileIndent.length) + rest;
			}
			return leading.startsWith(oldIndent) ? fileIndent + leading.slice(oldIndent.length) + rest : line;
		})
		.join("\n");
}

/**
 * Translate a match found in indentation-insensitive space into a replacement
 * in fuzzy space (which keeps the file's leading whitespace), and re-indent
 * newText to the file's indentation. Both spaces have identical line
 * structure; a stripped line is the fuzzy line minus its leading whitespace, so
 * offsets map line by line. A match starting at column 0 is widened to include
 * the line's indentation, which the re-indented newText then supplies itself.
 */
function translateIndentMatch(
	fuzzyContent: string,
	indentContent: string,
	oldText: string,
	newText: string,
	match: FuzzyMatchResult,
): TextReplacement {
	const fuzzyLines = splitLinesWithEndings(fuzzyContent);
	const fuzzySpans = getLineSpans(fuzzyContent);
	const indentSpans = getLineSpans(indentContent);

	const locate = (offset: number): { line: number; column: number } => {
		const line =
			offset >= indentContent.length
				? indentSpans.length - 1
				: indentSpans.findIndex((span) => offset >= span.start && offset < span.end);
		return { line, column: offset - indentSpans[line].start };
	};
	// Column 0 maps to the fuzzy line start so the match includes (or, for the
	// end offset, excludes) that line's indentation.
	const toFuzzyOffset = ({ line, column }: { line: number; column: number }): number =>
		fuzzySpans[line].start + (column === 0 ? 0 : getLeadingWhitespace(fuzzyLines[line]).length + column);

	const start = locate(match.index);
	const end = locate(match.index + match.matchLength);
	const fuzzyStart = toFuzzyOffset(start);
	const fuzzyEnd = toFuzzyOffset(end);

	// Only newText lines that start at a line boundary in the file are re-indented:
	// all of them when the match starts at column 0, otherwise all but the first.
	// The reference line is the first non-blank oldText line among those (blank
	// lines carry no indentation).
	const oldLines = oldText.split("\n");
	const fromLine = start.column === 0 ? 0 : 1;
	let refLine = fromLine;
	while (refLine < oldLines.length && oldLines[refLine].trim().length === 0) refLine++;
	const fileRefLine = fuzzyLines[start.line + refLine];
	const reindented =
		oldLines.length > refLine && fileRefLine !== undefined
			? reindentText(newText, getLeadingWhitespace(oldLines[refLine]), getLeadingWhitespace(fileRefLine), fromLine)
			: newText;

	return { matchIndex: fuzzyStart, matchLength: fuzzyEnd - fuzzyStart, newText: reindented };
}

function bigrams(text: string): Map<string, number> {
	const result = new Map<string, number>();
	for (let i = 0; i + 1 < text.length; i++) {
		const gram = text.slice(i, i + 2);
		result.set(gram, (result.get(gram) ?? 0) + 1);
	}
	return result;
}

/** Sorensen-Dice similarity of character bigrams, in [0, 1]. */
function lineSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const gramsA = bigrams(a);
	const gramsB = bigrams(b);
	let shared = 0;
	for (const [gram, count] of gramsA) {
		shared += Math.min(count, gramsB.get(gram) ?? 0);
	}
	return (2 * shared) / (a.length - 1 + b.length - 1);
}

const CLOSEST_MATCH_MIN_SIMILARITY = 0.4;
const CLOSEST_MATCH_MAX_CHARS = 600;
const CLOSEST_MATCH_MAX_LINES = 7;

/**
 * Find the region of `content` that most resembles the start of `oldText`, for
 * not-found error hints. Compares up to three leading oldText lines against
 * every aligned window of file lines (trimmed, fuzzy-normalized) using bigram
 * similarity. Returns a numbered snippet, or undefined when nothing is close.
 */
export function findClosestMatch(
	content: string,
	oldText: string,
): { startLine: number; endLine: number; snippet: string } | undefined {
	const contentLines = content.split("\n");
	if (contentLines[contentLines.length - 1] === "") contentLines.pop();
	const oldLines = normalizeForIndentInsensitiveMatch(oldText).split("\n");
	while (oldLines.length > 0 && oldLines[0] === "") oldLines.shift();
	while (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") oldLines.pop();
	const probe = oldLines.slice(0, 3);
	if (probe.length === 0) return undefined;

	const trimmedLines = normalizeForIndentInsensitiveMatch(content).split("\n");
	let bestIndex = -1;
	let bestScore = 0;
	for (let i = 0; i < trimmedLines.length; i++) {
		let score = 0;
		for (let j = 0; j < probe.length; j++) {
			score += lineSimilarity(probe[j], trimmedLines[i + j] ?? "");
		}
		score /= probe.length;
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}
	if (bestIndex === -1 || bestScore < CLOSEST_MATCH_MIN_SIMILARITY) return undefined;

	const lineCount = Math.min(oldLines.length + 2, CLOSEST_MATCH_MAX_LINES, contentLines.length - bestIndex);
	const snippetLines: string[] = [];
	let chars = 0;
	for (let i = bestIndex; i < bestIndex + lineCount; i++) {
		const line = `${i + 1}: ${contentLines[i]}`;
		if (snippetLines.length > 0 && chars + line.length > CLOSEST_MATCH_MAX_CHARS) break;
		snippetLines.push(line.length > CLOSEST_MATCH_MAX_CHARS ? `${line.slice(0, CLOSEST_MATCH_MAX_CHARS)}...` : line);
		chars += line.length + 1;
	}
	return { startLine: bestIndex + 1, endLine: bestIndex + snippetLines.length, snippet: snippetLines.join("\n") };
}

function getNotFoundError(
	path: string,
	content: string,
	oldText: string,
	editIndex: number,
	totalEdits: number,
): Error {
	const subject = totalEdits === 1 ? "the exact text" : `edits[${editIndex}]`;
	const closest = findClosestMatch(content, oldText);
	const hint = closest
		? `\nClosest match in ${path} at lines ${closest.startLine}-${closest.endLine} (line numbers are not part of the file):\n${closest.snippet}\nCopy the text to replace verbatim from the file (use read), including indentation.`
		: "";
	return new Error(
		`Could not find ${subject} in ${path}. Differences in trailing whitespace and indentation are tolerated, but the text itself must appear verbatim and be unique in the file.${hint}`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs a
 * tier beyond exact (see MatchTier), all offsets live in fuzzy space: the
 * replacements are applied in fuzzy-normalized content and the touched lines
 * are overlaid onto the original content, so unchanged line blocks keep their
 * original bytes. Edits that need the indent tier are matched with leading
 * whitespace stripped, then translated into fuzzy space with newText
 * re-indented to the file's indentation.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	let tier: MatchTier = "exact";
	const editTiers: MatchTier[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const match = fuzzyFindText(normalizedContent, normalizedEdits[i].oldText);
		if (!match) {
			throw getNotFoundError(path, normalizedContent, normalizedEdits[i].oldText, i, normalizedEdits.length);
		}
		editTiers.push(match.tier);
		if (MATCH_TIERS.indexOf(match.tier) > MATCH_TIERS.indexOf(tier)) tier = match.tier;
	}

	const replacementBaseContent = tier === "exact" ? normalizedContent : normalizeForFuzzyMatch(normalizedContent);
	const indentContent = tier === "indent" ? normalizeForIndentInsensitiveMatch(normalizedContent) : "";

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		// Edits that did not need the indent tier are matched in the replacement
		// base (fuzzy space unless every edit matched exactly), so an edit that is
		// unique in the file is not reported ambiguous just because another edit
		// needed indentation-insensitive matching.
		const editTier: MatchTier = editTiers[i] === "indent" ? "indent" : tier === "exact" ? "exact" : "fuzzy";
		const matchContent = editTier === "indent" ? indentContent : replacementBaseContent;
		const matchOldText = normalizeForTier(edit.oldText, editTier);
		const occurrences = matchContent.split(matchOldText).length - 1;
		if (occurrences === 0) {
			throw getNotFoundError(path, normalizedContent, edit.oldText, i, normalizedEdits.length);
		}
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		const match: FuzzyMatchResult = {
			tier: editTier,
			index: matchContent.indexOf(matchOldText),
			matchLength: matchOldText.length,
		};
		const replacement =
			editTier === "indent"
				? translateIndentMatch(replacementBaseContent, matchContent, edit.oldText, edit.newText, match)
				: { matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText };
		matchedEdits.push({ editIndex: i, ...replacement });
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent =
		tier === "exact"
			? applyReplacements(replacementBaseContent, matchedEdits)
			: applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
