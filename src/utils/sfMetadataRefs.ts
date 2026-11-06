/**
 * Pure scanners for the places Salesforce metadata refers to Apex by name (strings, not
 * code): LWC `@salesforce/apex/...` imports and their call sites, Aura `controller=` +
 * `c.method` action strings, Visualforce `controller=` / `extensions=` + `{!name}`
 * expressions, Flow `<actionName>` / `<apexClass>`, and Apex `Type.forName('Cls')`.
 *
 * Shared by the language server (Find References / rename on Apex) and the extension
 * host (LWC / Aura go-to-definition and references). No vscode / LSP imports — every
 * function works on plain text and returns character offsets.
 *
 * Apex names are case-insensitive, so class / member names match ignoring case. A
 * namespace prefix (`ns.Cls`, `ns__Cls`) is optional: when the project namespace is
 * known only that prefix is accepted, otherwise any prefix is.
 */

export interface Span {
	start: number;
	end: number;
}

export interface NamedSpan extends Span {
	/** The name as written (without any namespace prefix). */
	name: string;
	/** Namespace prefix as written, if any. */
	ns?: string;
}

/** Whether a written (possibly namespace-qualified) Apex class name refers to `cls`. */
export function classNameMatches(name: string, ns: string | undefined, cls: string, projectNs?: string | null): boolean {
	if (name.toLowerCase() !== cls.toLowerCase()) return false;
	if (!ns) return true;
	return !projectNs || ns.toLowerCase() === projectNs.toLowerCase();
}

/** Split `ns.Cls` / `ns__Cls` / `Cls` into name + namespace (offset of the name within the string). */
export function splitQualified(written: string): { ns?: string; name: string; nameOffset: number } {
	const dot = written.lastIndexOf(".");
	if (dot > 0) return { ns: written.slice(0, dot), name: written.slice(dot + 1), nameOffset: dot + 1 };
	const m = /^([A-Za-z][A-Za-z0-9]*)__([A-Za-z]\w*)$/.exec(written);
	// `ns__Cls` (namespace + double underscore), but not a custom object/field suffix like `X__c`.
	if (m && !/^(c|r|mdt|e|x|b)$/i.test(m[2])) return { ns: m[1], name: m[2], nameOffset: m[1].length + 2 };
	return { name: written, nameOffset: 0 };
}

// ─── JavaScript ─────────────────────────────────────────────────────────────────

/**
 * Blank JS comments (and, with `strings`, string / template-literal contents) to spaces,
 * preserving offsets and newlines. Template `${…}` expressions stay code.
 */
export function blankJs(text: string, strings = true): string {
	const out = text.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
	};
	const n = text.length;
	let i = 0;
	const tplStack: number[] = []; // brace depth at which each open template's `${` started
	let braceDepth = 0;
	const scanString = (q: string) => {
		const start = i;
		i++;
		while (i < n && text[i] !== q && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
		i++;
		if (strings) blank(start + 1, Math.min(i - 1, n));
	};
	const scanTemplate = () => {
		// at a backtick or after a `}` closing an expression; scan template text
		const start = i;
		while (i < n) {
			if (text[i] === "\\") {
				i += 2;
				continue;
			}
			if (text[i] === "`") {
				if (strings) blank(start, i);
				i++;
				return;
			}
			if (text[i] === "$" && text[i + 1] === "{") {
				if (strings) blank(start, i);
				i += 2;
				tplStack.push(braceDepth);
				braceDepth++;
				return;
			}
			i++;
		}
		if (strings) blank(start, n);
	};
	while (i < n) {
		const c = text[i];
		if (c === "/" && text[i + 1] === "/") {
			const e = text.indexOf("\n", i);
			const end = e === -1 ? n : e;
			blank(i, end);
			i = end;
		} else if (c === "/" && text[i + 1] === "*") {
			const e = text.indexOf("*/", i + 2);
			const end = e === -1 ? n : e + 2;
			blank(i, end);
			i = end;
		} else if (c === "'" || c === '"') {
			scanString(c);
		} else if (c === "`") {
			i++;
			scanTemplate();
		} else if (c === "{") {
			braceDepth++;
			i++;
		} else if (c === "}") {
			braceDepth--;
			i++;
			if (tplStack.length && tplStack[tplStack.length - 1] === braceDepth) {
				tplStack.pop();
				scanTemplate();
			}
		} else {
			i++;
		}
	}
	return out.join("");
}

export interface LwcApexImport {
	/** Local binding (`import getAccounts from …`), if a default import. */
	local?: NamedSpan;
	ns?: string;
	cls: NamedSpan;
	method: NamedSpan;
	/** The whole module specifier (inside the quotes). */
	spec: Span;
}

const APEX_IMPORT =
	/\bimport\s+(?:([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?|\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s*from\s*(['"])(@salesforce\/apex(?:Continuation)?\/)([\w.]+)\2/g;

/** Every `@salesforce/apex/[ns.]Class.method` import of an LWC module. */
export function lwcApexImports(text: string): LwcApexImport[] {
	const code = blankJs(text, false);
	const out: LwcApexImport[] = [];
	for (const m of code.matchAll(APEX_IMPORT)) {
		const at = m.index ?? 0;
		const path = m[4];
		const parts = path.split(".");
		if (parts.length < 2 || parts.length > 3) continue;
		const specStart = at + m[0].length - 1 - path.length - m[3].length;
		const pathStart = specStart + m[3].length;
		const method = parts[parts.length - 1];
		const cls = parts[parts.length - 2];
		const ns = parts.length === 3 ? parts[0] : undefined;
		const clsStart = pathStart + (ns ? ns.length + 1 : 0);
		const methodStart = clsStart + cls.length + 1;
		const imp: LwcApexImport = {
			ns,
			cls: { name: cls, ns, start: clsStart, end: clsStart + cls.length },
			method: { name: method, start: methodStart, end: methodStart + method.length },
			spec: { start: specStart, end: pathStart + path.length },
		};
		if (m[1]) {
			const ls = at + m[0].indexOf(m[1], "import".length);
			imp.local = { name: m[1], start: ls, end: ls + m[1].length };
		}
		out.push(imp);
	}
	return out;
}

/**
 * Code uses of a JS identifier (case-sensitive): not in comments/strings, not a member
 * access (`this.name`), not an object-literal key (`{ name: … }`). Includes the import
 * binding itself.
 */
export function jsIdentifierUses(text: string, name: string, code = blankJs(text)): Span[] {
	const out: Span[] = [];
	const re = new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$")}(?![\\w$])`, "g");
	for (const m of code.matchAll(re)) {
		const s = m.index ?? 0;
		const e = s + name.length;
		// `.name` with whitespace before the dot
		let j = s - 1;
		while (j >= 0 && /\s/.test(code[j])) j--;
		if (code[j] === "." && code[j - 1] !== ".") continue;
		// `{ name: …` / `, name: …` (object key) — but not `a ? name : b`
		if (/^\s*:/.test(code.slice(e, e + 40)) && (code[j] === "{" || code[j] === ",")) continue;
		out.push({ start: s, end: e });
	}
	return out;
}

/**
 * References to an Apex method (or, with `method` undefined, the class) in one LWC
 * module: the import specifier segment, plus — for methods — the local binding and all
 * its code uses (`@wire(binding, …)`, `binding({...})`).
 */
export function lwcApexRefs(text: string, cls: string, method: string | undefined, projectNs?: string | null): Span[] {
	const out: Span[] = [];
	let code: string | undefined;
	for (const imp of lwcApexImports(text)) {
		if (!classNameMatches(imp.cls.name, imp.ns, cls, projectNs)) continue;
		if (method === undefined) {
			out.push({ start: imp.cls.start, end: imp.cls.end });
			continue;
		}
		if (imp.method.name.toLowerCase() !== method.toLowerCase()) continue;
		out.push({ start: imp.method.start, end: imp.method.end });
		if (imp.local) {
			code ??= blankJs(text);
			out.push(...jsIdentifierUses(text, imp.local.name, code));
		}
	}
	return dedupe(out);
}

/** The `@salesforce/apex` import (and which part of it) under `offset`, by spec or by local binding. */
export function lwcApexImportAt(text: string, offset: number): { imp: LwcApexImport; on: "spec" | "binding" | "use" } | undefined {
	const imports = lwcApexImports(text);
	for (const imp of imports) {
		if (offset >= imp.spec.start && offset <= imp.spec.end) return { imp, on: "spec" };
		if (imp.local && offset >= imp.local.start && offset <= imp.local.end) return { imp, on: "binding" };
	}
	const code = blankJs(text);
	for (const imp of imports) {
		if (!imp.local) continue;
		for (const u of jsIdentifierUses(text, imp.local.name, code)) {
			if (offset >= u.start && offset <= u.end) return { imp, on: "use" };
		}
	}
	return undefined;
}

// ─── Aura ───────────────────────────────────────────────────────────────────────

/** `controller="[ns.]Cls"` on an `<aura:component>` / `<aura:application>` / `<aura:event>`… root tag. */
export function auraControllerRef(cmpText: string): NamedSpan | undefined {
	const code = blankXmlComments(cmpText);
	const tag = /<aura:(?:component|application)\b[^>]*>/i.exec(code);
	if (!tag) return undefined;
	const attr = /\bcontroller\s*=\s*(["'])([\w.]+)\1/i.exec(tag[0]);
	if (!attr) return undefined;
	const valStart = (tag.index ?? 0) + (attr.index ?? 0) + attr[0].indexOf(attr[1]) + 1;
	const q = splitQualified(attr[2]);
	return { name: q.name, ns: q.ns, start: valStart + q.nameOffset, end: valStart + attr[2].length };
}

/** `'c.method'` / `"c.method"` server-action strings in Aura controller / helper JS. */
export function auraActionRefs(jsText: string, method?: string): NamedSpan[] {
	const code = blankJs(jsText, false);
	const out: NamedSpan[] = [];
	for (const m of code.matchAll(/(["'])c\.([A-Za-z_]\w*)\1/g)) {
		const name = m[2];
		if (method !== undefined && name.toLowerCase() !== method.toLowerCase()) continue;
		const s = (m.index ?? 0) + 3;
		out.push({ name, start: s, end: s + name.length });
	}
	return out;
}

/** The `c.method` action string under `offset`, if any. */
export function auraActionAt(jsText: string, offset: number): NamedSpan | undefined {
	return auraActionRefs(jsText).find((r) => offset >= r.start - 2 && offset <= r.end);
}

// ─── Visualforce ────────────────────────────────────────────────────────────────

function blankXmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** `controller="Cls"` and each `extensions="A, B"` class on `<apex:page>` / `<apex:component>`. */
export function vfControllerRefs(text: string): NamedSpan[] {
	const code = blankXmlComments(text);
	const out: NamedSpan[] = [];
	for (const tag of code.matchAll(/<apex:(?:page|component)\b[^>]*>/gi)) {
		const tagAt = tag.index ?? 0;
		for (const attr of tag[0].matchAll(/\b(controller|extensions)\s*=\s*(["'])([^"']*)\2/gi)) {
			const valStart = tagAt + (attr.index ?? 0) + attr[0].indexOf(attr[2]) + 1;
			const value = attr[3];
			for (const item of value.matchAll(/[\w.]+/g)) {
				const q = splitQualified(item[0]);
				const s = valStart + (item.index ?? 0) + q.nameOffset;
				out.push({ name: q.name, ns: q.ns, start: s, end: s + q.name.length });
			}
		}
	}
	return out;
}

/**
 * Root identifiers of `{! … }` merge expressions matching one of `names` (case-insensitive):
 * `{!recent}`, `action="{!save}"`, `{!IF(flag, a, b)}` — but not `{!acc.Name}`'s `Name`,
 * `$Label.x`, or anything inside an HTML comment.
 */
export function vfExpressionRefs(text: string, names: string[]): NamedSpan[] {
	if (!names.length) return [];
	const wanted = new Set(names.map((n) => n.toLowerCase()));
	const code = blankXmlComments(text);
	const out: NamedSpan[] = [];
	for (const ex of code.matchAll(/\{!([^}]*)\}/g)) {
		const base = (ex.index ?? 0) + 2;
		const body = ex[1].replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (m) => " ".repeat(m.length));
		for (const id of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
			const s = id.index ?? 0;
			let j = s - 1;
			while (j >= 0 && /\s/.test(body[j])) j--;
			if (body[j] === "." || body[j] === "$" || id[0].startsWith("$")) continue;
			if (!wanted.has(id[0].toLowerCase())) continue;
			out.push({ name: id[0], start: base + s, end: base + s + id[0].length });
		}
	}
	return out;
}

/** The names a Visualforce page uses to reach an Apex member: `getFoo()` → `foo`, `setFoo(x)` → `foo`, else the name. */
export function vfNamesForMember(name: string, kind: "method" | "field" | "property", arity?: number): string[] {
	if (kind !== "method") return [name];
	const g = /^get([A-Za-z_]\w*)$/i.exec(name);
	if (g && (arity ?? 0) === 0) return [g[1]];
	const s = /^set([A-Za-z_]\w*)$/i.exec(name);
	if (s && arity === 1) return [s[1]];
	return [name];
}

// ─── Flow ───────────────────────────────────────────────────────────────────────

/**
 * Apex classes a Flow refers to: `<actionName>` of `<actionCalls>` whose `<actionType>` is
 * `apex` (an @InvocableMethod class), and `<apexClass>` (Apex-defined variables / plugins).
 */
export function flowApexRefs(xml: string): (NamedSpan & { tag: "actionName" | "apexClass" })[] {
	const code = blankXmlComments(xml);
	const out: (NamedSpan & { tag: "actionName" | "apexClass" })[] = [];
	const push = (tag: "actionName" | "apexClass", value: string, valStart: number) => {
		const v = value.trim();
		if (!/^[\w.]+$/.test(v)) return;
		const q = splitQualified(v);
		const s = valStart + value.indexOf(v) + q.nameOffset;
		out.push({ tag, name: q.name, ns: q.ns, start: s, end: s + q.name.length });
	};
	for (const block of code.matchAll(/<actionCalls>([\s\S]*?)<\/actionCalls>/g)) {
		const body = block[1];
		if (!/<actionType>\s*apex\s*<\/actionType>/i.test(body)) continue;
		const an = /<actionName>([^<]*)<\/actionName>/.exec(body);
		if (an) push("actionName", an[1], (block.index ?? 0) + "<actionCalls>".length + (an.index ?? 0) + "<actionName>".length);
	}
	for (const m of code.matchAll(/<apexClass>([^<]*)<\/apexClass>/g)) push("apexClass", m[1], (m.index ?? 0) + "<apexClass>".length);
	return out;
}

// ─── Apex ───────────────────────────────────────────────────────────────────────

/** `Type.forName('Cls')`, `Type.forName('ns', 'Cls')`, `Type.forName('Outer.Inner')` string references. */
export function typeForNameRefs(apexText: string): NamedSpan[] {
	const out: NamedSpan[] = [];
	const re = /\bType\s*\.\s*forName\s*\(\s*'([^'\n]*)'(?:\s*,\s*'([^'\n]*)')?\s*\)/gi;
	for (const m of apexText.matchAll(re)) {
		const at = m.index ?? 0;
		if (m[2] !== undefined) {
			const s = at + m[0].lastIndexOf(`'${m[2]}'`) + 1;
			out.push({ name: m[2], ns: m[1] || undefined, start: s, end: s + m[2].length });
			continue;
		}
		const v = m[1];
		const s0 = at + m[0].indexOf(`'${v}'`) + 1;
		const q = splitQualified(v);
		out.push({ name: q.name, ns: q.ns, start: s0 + q.nameOffset, end: s0 + v.length });
	}
	return out;
}

// ─── misc ───────────────────────────────────────────────────────────────────────

function dedupe(spans: Span[]): Span[] {
	const seen = new Set<string>();
	return spans
		.filter((s) => {
			const k = `${s.start}:${s.end}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		})
		.sort((a, b) => a.start - b.start);
}

/** Line starts of a text (for offset → position). */
export function lineStartsOf(text: string): number[] {
	const out = [0];
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) out.push(i + 1);
	return out;
}

/** Offset → { line, character } using precomputed line starts. */
export function positionAtOffset(lineStarts: number[], offset: number): { line: number; character: number } {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo, character: offset - lineStarts[lo] };
}

/** Kind of Salesforce metadata file a path is (for reference scanning), or undefined. */
export type MetadataKind = "lwc" | "auraJs" | "auraCmp" | "vf" | "flow";

export function metadataKindOf(file: string): MetadataKind | undefined {
	const f = file.replace(/\\/g, "/");
	if (/\/lwc\/[^/]+\/(?:[^/]+\/)*[^/]+\.(js|ts)$/i.test(f)) return "lwc";
	if (/\/aura\/[^/]+\/[^/]+\.js$/i.test(f)) return "auraJs";
	if (/\/aura\/[^/]+\/[^/]+\.(cmp|app)$/i.test(f)) return "auraCmp";
	if (/\.(page|component)$/i.test(f)) return "vf";
	if (/\.flow-meta\.xml$/i.test(f)) return "flow";
	return undefined;
}
