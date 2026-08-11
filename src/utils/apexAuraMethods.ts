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

/** A custom Apex type (class) exposed to LWC, and the `@AuraEnabled` members it serializes. */
export interface ApexTypeShape {
    name: string;
    properties: ApexParam[];
}

/**
 * Find the `@AuraEnabled` properties/fields of every class in a source file — including inner
 * classes, which is how most wrapper/DTO types are written. These become TypeScript interfaces so
 * a custom parameter or return type stops being `any`.
 */
export function findApexTypeShapes(source: string): ApexTypeShape[] {
    if (!source) return [];
    const code = blankComments(source);
    const shapes: ApexTypeShape[] = [];
    const classRe = /\bclass\s+([A-Za-z_]\w*)/g;
    let c: RegExpExecArray | null;
    while ((c = classRe.exec(code)) !== null) {
        const bodyStart = code.indexOf("{", c.index);
        if (bodyStart < 0) continue;
        // Walk to the matching close brace so inner classes are scoped correctly.
        let depth = 0;
        let end = bodyStart;
        for (let i = bodyStart; i < code.length; i++) {
            if (code[i] === "{") depth++;
            else if (code[i] === "}") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        const body = code.slice(bodyStart + 1, end);
        // Only direct members: strip nested class bodies so inner members aren't double-counted.
        const own = body.replace(/\bclass\s+[A-Za-z_]\w*[^{]*\{[\s\S]*?\n\s*\}/g, "");
        const properties: ApexParam[] = [];
        // @AuraEnabled … <Type> name ; | = | { get; set; }   (never a method — no "(" after the name)
        const propRe =
            /@AuraEnabled\s*(?:\([^)]*\))?\s*(?:(?:public|global|private|protected|static|final|transient)\s+)*([\w.<>,[\]\s]+?)\s+([A-Za-z_]\w*)\s*(?=[;={])/g;
        let p: RegExpExecArray | null;
        while ((p = propRe.exec(own)) !== null) {
            const type = p[1].replace(/\s+/g, " ").trim();
            if (!type || /\bclass\b/.test(type)) continue;
            properties.push({ type, name: p[2] });
        }
        if (properties.length) shapes.push({ name: c[1], properties });
    }
    return shapes;
}

/**
 * Map an Apex type to the closest TypeScript type. `knownTypes` are custom Apex classes we emit
 * interfaces for — when a type is in that set it is referenced by name instead of collapsing to `any`.
 */
export function apexTypeToTs(apexType: string, knownTypes?: Set<string>): string {
    const t = apexType.trim();
    const generic = /^(List|Set|Iterable)\s*<\s*([\s\S]+)\s*>$/i.exec(t);
    if (generic) return `${apexTypeToTs(generic[2], knownTypes)}[]`;
    const map = /^Map\s*<\s*([^,]+),\s*([\s\S]+)\s*>$/i.exec(t);
    if (map) return `Record<string, ${apexTypeToTs(map[2], knownTypes)}>`;
    if (/\[\]$/.test(t)) return `${apexTypeToTs(t.replace(/\[\]$/, ""), knownTypes)}[]`;
    // A custom Apex class we have a shape for → use its generated interface.
    const bare = t.includes(".") ? t.split(".").pop()!.trim() : t;
    if (knownTypes?.has(bare)) return bare;

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
export function declarationFor(className: string, m: AuraMethod, knownTypes?: Set<string>): string {
    const ret = apexTypeToTs(m.returnType, knownTypes);
    const params = m.params.map((p) => `${p.name}: ${apexTypeToTs(p.type, knownTypes)}`).join(", ");
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
export function typingsForClass(className: string, source: string, knownTypes?: Set<string>): string | undefined {
    const methods = findAuraEnabledMethods(source);
    if (!methods.length) return undefined;
    const header = [
        "// Generated by ASFX Toolkit from the Apex source — types reflect the real @AuraEnabled",
        "// signatures. Regenerate with: ASFXT: Generate LWC Apex Typings.",
        ""
    ].join("\n");
    return header + methods.map((m) => declarationFor(className, m, knownTypes)).join("\n") + "\n";
}

/**
 * Emit the shared TypeScript interfaces for custom Apex types. Written to a single ambient .d.ts
 * (no imports/exports, so the interfaces are global) which the per-class module declarations then
 * reference by name.
 */
export function interfacesForShapes(shapes: ApexTypeShape[]): string {
    const known = new Set(shapes.map((s) => s.name));
    const header = [
        "// Generated by ASFX Toolkit from your Apex @AuraEnabled types.",
        "// Ambient interfaces referenced by the @salesforce/apex module declarations.",
        ""
    ].join("\n");
    const body = shapes
        .map((shape) => {
            const props = shape.properties
                .map((p) => `  /** Apex: \`${p.type}\` */\n  ${p.name}?: ${apexTypeToTs(p.type, known)};`)
                .join("\n");
            return `interface ${shape.name} {\n${props}\n}`;
        })
        .join("\n\n");
    return header + body + "\n";
}
