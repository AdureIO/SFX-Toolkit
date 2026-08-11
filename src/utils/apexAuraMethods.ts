/**
 * Scan an Apex class for the `@AuraEnabled` methods an LWC can import via
 * `@salesforce/apex/<Class>.<method>`, capturing the real signature — return type, parameter
 * names AND types, cacheable flag, doc comment and line — so the editor can offer click-through
 * to the method and show types instead of Salesforce's generated `any` stubs.
 *
 * Pure + testable (no `vscode`). Deliberately a focused scanner rather than a full parse: it only
 * needs top-level `@AuraEnabled` method signatures, which are simple and stable to match.
 */

export interface ApexParam {
    name: string;
    /** Apex type as written, e.g. `Map<String, Object>`. */
    type: string;
}

export interface AuraMethod {
    name: string;
    /** Apex return type as written, e.g. `List<Account>` or `void`. */
    returnType: string;
    params: ApexParam[];
    /** True for `@AuraEnabled(cacheable=true)` — importable with @wire. */
    cacheable: boolean;
    /** 0-based line of the method declaration, for go-to-definition. */
    line: number;
    /** 0-based column where the method name starts. */
    column: number;
    /** Leading ApexDoc block comment, cleaned of leading asterisks, when present. */
    doc?: string;
}

/** Strip block/line comments but keep offsets stable by replacing with spaces. */
function blankComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Split a parameter list on top-level commas (ignores commas inside generics like Map<String, Object>). */
function splitParams(list: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of list) {
        if (ch === "<" || ch === "(" || ch === "[") depth++;
        else if (ch === ">" || ch === ")" || ch === "]") depth--;
        if (ch === "," && depth === 0) {
            out.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) out.push(current);
    return out.map((p) => p.trim()).filter(Boolean);
}

/** `Map<String, Object> params` → { type: "Map<String, Object>", name: "params" } */
function parseParam(text: string): ApexParam | undefined {
    // Drop modifiers Apex allows on params (e.g. `final`).
    const cleaned = text.replace(/^\s*final\s+/i, "").trim();
    const m = /^(.*[>\]\w])\s+([A-Za-z_]\w*)$/.exec(cleaned);
    if (!m) return undefined;
    return { type: m[1].trim(), name: m[2] };
}

/** The ApexDoc block immediately above `index`, cleaned, or undefined. */
function docAbove(src: string, index: number): string | undefined {
    const before = src.slice(0, index);
    const m = /\/\*\*([\s\S]*?)\*\/\s*(?:@[\w.()=\s,'"]*\s*)*$/.exec(before);
    if (!m) return undefined;
    const text = m[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\*ic?/, "").replace(/^\s*\*\s?/, "").trim())
        .join("\n")
        .trim();
    return text || undefined;
}

/** Find every `@AuraEnabled` method in an Apex class body. */
export function findAuraEnabledMethods(source: string): AuraMethod[] {
    if (!source) return [];
    const code = blankComments(source);
    const out: AuraMethod[] = [];

    // @AuraEnabled [(cacheable=true)] … modifiers … <ReturnType> name ( params )
    const re =
        /@AuraEnabled\s*(\([^)]*\))?\s*((?:(?:public|global|private|protected|static|override|virtual|abstract|final|transient)\s+)*)([\w.<>,[\]\s]+?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
        const [, annotationArgs, , returnTypeRaw, name, paramList] = m;
        const returnType = returnTypeRaw.replace(/\s+/g, " ").trim();
        if (!returnType || /^(?:if|for|while|switch|catch|new|return)$/i.test(name)) continue;

        const nameIndex = m.index + m[0].lastIndexOf(name + "(" ) ;
        const upto = code.slice(0, nameIndex);
        const line = upto.split("\n").length - 1;
        const column = nameIndex - (upto.lastIndexOf("\n") + 1);

        out.push({
            name,
            returnType,
            params: splitParams(paramList).map(parseParam).filter((p): p is ApexParam => !!p),
            cacheable: /cacheable\s*=\s*true/i.test(annotationArgs ?? ""),
            line,
            column,
            doc: docAbove(source, m.index)
        });
    }
    return out;
}

/** Human-readable Apex signature, e.g. `List<Event> getEventData(Map<String, Object> params)`. */
export function formatSignature(m: AuraMethod): string {
    const params = m.params.map((p) => `${p.type} ${p.name}`).join(", ");
    return `${m.returnType} ${m.name}(${params})`;
}

/** Map an Apex type to the closest TypeScript type, for generated LWC typings. */
export function apexTypeToTs(apexType: string): string {
    const t = apexType.trim();
    const generic = /^(List|Set|Iterable)\s*<\s*([\s\S]+)\s*>$/i.exec(t);
    if (generic) return `${apexTypeToTs(generic[2])}[]`;
    const map = /^Map\s*<\s*([^,]+),\s*([\s\S]+)\s*>$/i.exec(t);
    if (map) return `Record<string, ${apexTypeToTs(map[2])}>`;
    if (/\[\]$/.test(t)) return `${apexTypeToTs(t.replace(/\[\]$/, ""))}[]`;

    switch (t.toLowerCase()) {
        case "string":
        case "id":
        case "blob":
            return "string";
        case "integer":
        case "long":
        case "double":
        case "decimal":
            return "number";
        case "boolean":
            return "boolean";
        case "date":
        case "datetime":
        case "time":
            return "string"; // serialized over the wire
        case "object":
        case "sobject":
        case "void":
            return t.toLowerCase() === "void" ? "void" : "any";
        default:
            return "any"; // SObjects and custom Apex types serialize to plain objects
    }
}

// ── LWC bridge helpers (pure) ──────────────────────────────────────────────────────────────────

/** `@salesforce/apex/DataSourceController.getEventData` → { className, methodName }. */
export function parseApexImport(spec: string): { className: string; methodName: string } | undefined {
    const m = /^@salesforce\/apex\/([\w]+(?:\.[\w]+)?)\.([\w]+)$/.exec(spec.trim());
    if (!m) return undefined;
    return { className: m[1], methodName: m[2] };
}

/** The TypeScript declaration for one `@AuraEnabled` method, as LWC imports it. */
export function declarationFor(className: string, m: AuraMethod): string {
    const ret = apexTypeToTs(m.returnType);
    const params = m.params.map((p) => `${p.name}: ${apexTypeToTs(p.type)}`).join(", ");
    // Apex methods are called from LWC with a single object of named params.
    const arg = m.params.length ? `param: {${params}}` : "";
    const docLines = [`Apex: \`${formatSignature(m)}\``];
    if (m.cacheable) docLines.push("", "`cacheable` — usable with `@wire`.");
    if (m.doc) docLines.push("", ...m.doc.split("\n"));
    const doc = ["/**", ...docLines.map((l) => ` * ${l}`.trimEnd()), " */"].join("\n");
    return [
        `declare module "@salesforce/apex/${className}.${m.name}" {`,
        doc.replace(/^/gm, "  "),
        `  export default function ${m.name}(${arg}): Promise<${ret}>;`,
        "}"
    ].join("\n");
}

/** Full .d.ts body for one Apex class, or undefined when it exposes nothing to LWC. */
export function typingsForClass(className: string, source: string): string | undefined {
    const methods = findAuraEnabledMethods(source);
    if (!methods.length) return undefined;
    const header = [
        "// Generated by ASFX Toolkit from the Apex source — types reflect the real @AuraEnabled",
        "// signatures. Regenerate with: ASFXT: Generate LWC Apex Typings.",
        ""
    ].join("\n");
    return header + methods.map((m) => declarationFor(className, m)).join("\n") + "\n";
}
