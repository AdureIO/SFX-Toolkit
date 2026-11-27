/**
 * Test item ids for the Apex Test Explorer (no `vscode`, unit testable).
 * Ids carry the project dir so classes with the same name in different projects never collide:
 *   class:<projectDir>::<ClassName>            (class item)
 *   class:<projectDir>::<ClassName>.<method>   (method item)
 * Class and method names never contain "::", so the LAST "::" separates the dir from the name.
 */
const PREFIX = "class:";
const SEP = "::";

export interface ParsedTestId {
	projectDir: string;
	className: string;
	method?: string;
}

export function classTestId(projectDir: string, className: string): string {
	return `${PREFIX}${projectDir}${SEP}${className}`;
}

export function methodTestId(projectDir: string, className: string, method: string): string {
	return `${classTestId(projectDir, className)}.${method}`;
}

export function parseTestId(id: string): ParsedTestId | undefined {
	if (!id.startsWith(PREFIX)) return undefined;
	const rest = id.slice(PREFIX.length);
	const at = rest.lastIndexOf(SEP);
	if (at < 0) return undefined;
	const projectDir = rest.slice(0, at);
	const name = rest.slice(at + SEP.length);
	const dot = name.indexOf(".");
	return dot < 0
		? { projectDir, className: name }
		: { projectDir, className: name.slice(0, dot), method: name.slice(dot + 1) };
}

/** `Class` or `Class.method`, as `sf apex run test` expects it. */
export function cliTestName(parsed: ParsedTestId): string {
	return parsed.method ? `${parsed.className}.${parsed.method}` : parsed.className;
}
