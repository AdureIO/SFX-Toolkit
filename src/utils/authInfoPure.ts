/** Pure formatting of auth warm-up failures (no vscode import, unit tested). */

function tryParse(s: string): any {
	const start = s.indexOf("{");
	if (start < 0) return null;
	try {
		return JSON.parse(s.slice(start));
	} catch {
		return null;
	}
}

/**
 * One log line for a failed background auth warm-up. The CLI reports errors as JSON (name, code,
 * message, cause, stack); `e` may be an Error whose message is that JSON, or the object itself.
 */
export function formatWarmupFailure(org: string | null, e: unknown): string {
	const err: any = e;
	let obj: any = err && typeof err === "object" && !(err instanceof Error) ? err : null;
	const rawMsg = String(err?.message ?? err ?? "");
	if (!obj) obj = tryParse(rawMsg);
	const name = String(obj?.name ?? obj?.code ?? err?.name ?? "Error");
	const code = obj?.code ? String(obj.code) : "";
	const label = obj?.name && code && code !== obj.name ? `${obj.name}/${code}` : name;
	const message = String(obj?.message ?? rawMsg).split(/\r?\n/)[0].trim();
	const causeText = (() => {
		const c = obj?.cause;
		if (!c) return "";
		return typeof c === "string" ? c : JSON.stringify(c);
	})();
	const unresolved = /MyDomainResolverTimeoutError/.test(causeText) || code === "DomainNotFoundError" || obj?.name === "DomainNotFoundError";
	return `AuthInfo: background auth warm-up failed${org ? ` (${org})` : ""}: ${label}: ${message}${
		unresolved ? " (the org's domain doesn't resolve; it may have been deleted or refreshed)" : ""
	}`;
}
