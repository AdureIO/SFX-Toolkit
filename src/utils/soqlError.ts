/**
 * Parse a Salesforce SOQL query error into a clean message + the location it
 * points at, so the editor can surface it inline (red marker) instead of dumping
 * the raw API payload. Pure + testable.
 *
 * Salesforce errors look like:
 *   HTTP 400: [{"message":"\n<snippet>\n        ^\nERROR at Row:1:Column:102\n<text>","errorCode":"MALFORMED_QUERY"}]
 */
export interface ParsedSoqlError {
	message: string;
	code?: string;
	line?: number; // 1-based, as reported by the API
	column?: number; // 1-based
}

export function parseSoqlError(raw: string): ParsedSoqlError {
	if (!raw) return { message: "Query failed." };
	let payloadMessage = raw;
	let code: string | undefined;

	// Pull the JSON array body if present (after "HTTP 400: ").
	const br = raw.indexOf("[");
	if (br >= 0) {
		try {
			const arr = JSON.parse(raw.slice(br));
			const first = Array.isArray(arr) ? arr[0] : arr;
			if (first && typeof first.message === "string") payloadMessage = first.message;
			if (first && typeof first.errorCode === "string") code = first.errorCode;
		} catch {
			/* not JSON — fall back to the raw string */
		}
	}

	const loc = /Row:(\d+):Column:(\d+)/.exec(payloadMessage);
	const line = loc ? parseInt(loc[1], 10) : undefined;
	const column = loc ? parseInt(loc[2], 10) : undefined;

	// The human-readable text is whatever follows the "ERROR at Row:..:Column:.." line.
	let message: string;
	const after = /ERROR at Row:\d+:Column:\d+\s*\n?([\s\S]*)$/.exec(payloadMessage);
	if (after && after[1].trim()) {
		message = after[1].trim();
	} else {
		// No positional preamble — strip a leading snippet/caret block if any.
		message = payloadMessage
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !/^\^+$/.test(l) && !/^ERROR at Row/.test(l))
			.pop() || payloadMessage.trim();
	}

	return { message, code, line, column };
}
