import { minimatch } from "minimatch";

export interface ShouldStripInput {
  enabled: boolean;
  languageId: string;
  relPath: string;
  languages: string[];
  patterns: string[];
}

export interface StripResult {
  text: string;
  removed: number;
}

/**
 * Counts how many trailing newline characters (\n or \r\n) appear at the end of the
 * given text. Only newline characters are counted; other whitespace (spaces, tabs)
 * is left untouched.
 */
export function computeTrailingNewlineLength(text: string): number {
  if (!text) {
    return 0;
  }
  let i = text.length;
  while (i > 0) {
    const ch = text.charCodeAt(i - 1);
    if (ch === 0x0a /* \n */) {
      i -= 1;
      if (i > 0 && text.charCodeAt(i - 1) === 0x0d /* \r */) {
        i -= 1;
      }
      continue;
    }
    break;
  }
  return text.length - i;
}

/**
 * Returns the input with all trailing \n / \r\n sequences removed. Idempotent: a
 * second invocation on the result yields removed === 0 and the same text.
 */
export function stripTrailingNewlines(text: string): StripResult {
  const removed = computeTrailingNewlineLength(text);
  if (removed === 0) {
    return { text, removed: 0 };
  }
  return { text: text.slice(0, text.length - removed), removed };
}

/**
 * Tests a workspace-relative POSIX path against a list of globs. Returns true on
 * the first match. Empty pattern list always returns false (the caller is required
 * to opt in by configuring at least one glob).
 */
export function matchesAnyPattern(relPosixPath: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const normalized = relPosixPath.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      continue;
    }
    if (minimatch(normalized, pattern, { dot: true })) {
      return true;
    }
  }
  return false;
}

/**
 * Combines the configuration gates (enabled flag, language list, glob list) into a
 * single decision. Kept pure so it can be exercised without the VS Code host.
 */
export function shouldStripFor(input: ShouldStripInput): boolean {
  if (!input.enabled) {
    return false;
  }
  if (!input.languages || input.languages.length === 0) {
    return false;
  }
  if (!input.languages.includes(input.languageId)) {
    return false;
  }
  return matchesAnyPattern(input.relPath, input.patterns);
}
