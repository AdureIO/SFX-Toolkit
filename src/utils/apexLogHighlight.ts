/**
 * Shared debug-log highlighting configuration, used both by the native `.log`
 * editor decorator and the Execute Apex results pane so colors stay consistent.
 *
 * Mirrors the shape of the popular `logFileHighlighter.customPatterns` setting:
 * a regex per rule with a foreground color, optional font style, and an option
 * to color the whole line. Configurable via `adure-sfx-toolkit.apexLog.highlightPatterns`.
 */
import * as vscode from "vscode";

export interface HighlightPattern {
	pattern: string;
	foreground?: string;
	fontStyle?: "normal" | "bold" | "italic" | "bold italic";
	highlightEntireLine?: boolean;
}

const FALLBACK: HighlightPattern[] = [
	{ pattern: "\\|FATAL_ERROR\\|.*", foreground: "#f64b4b", highlightEntireLine: true },
	{ pattern: "\\|EXCEPTION_THROWN\\|.*", foreground: "#f64b4b", highlightEntireLine: true },
	{ pattern: "\\|USER_DEBUG\\|.*", foreground: "#6c64ff", fontStyle: "bold", highlightEntireLine: true },
	{ pattern: "\\|SOQL_EXECUTE_BEGIN\\|.*", foreground: "#15d274", fontStyle: "bold", highlightEntireLine: true },
	{ pattern: "\\|DML_BEGIN\\|.*", foreground: "#e2c08d", fontStyle: "bold", highlightEntireLine: true },
];

/** Highlight rules from settings (falls back to the built-in defaults). */
export function getHighlightPatterns(): HighlightPattern[] {
	const raw = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<HighlightPattern[]>("apexLog.highlightPatterns");
	if (!Array.isArray(raw) || raw.length === 0) return FALLBACK;
	return raw.filter((p) => p && typeof p.pattern === "string" && p.pattern.length > 0);
}
