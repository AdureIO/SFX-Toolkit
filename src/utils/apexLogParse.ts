/**
 * Pure parsing helpers for Apex debug logs (no I/O), kept separate so they can be
 * unit-tested without the network/vscode dependencies of apexLogApi.
 */

/**
 * The entry-point code unit of a debug log (what was actually run) from the first
 * CODE_UNIT_STARTED line — e.g. "MyClass.myMethod", "execute_anonymous_apex",
 * "MyTrigger on Account trigger event BeforeInsert". Null if not present.
 */
export function extractCodeUnit(logBody: string): string | null {
	const line = /^.*\|CODE_UNIT_STARTED\|.*$/m.exec(logBody)?.[0];
	if (!line) return null;
	const parts = line.split("|");
	const name = (parts[parts.length - 1] || "").trim();
	return name || null;
}
