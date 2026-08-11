/**
 * Heuristic scanner that finds which SObject fields an Apex body WRITES.
 *
 * Pure + testable (no vscode / no parser dependency). Works on a class or trigger
 * body retrieved from the org (so it covers code that isn't in the local project).
 * It infers the SObject type of local variables from their declarations, then flags:
 *   - `var.Field = …`            (assignment)
 *   - `new Object(Field = …)`    (constructor named args)
 *   - `var.put('Field', …)`      (dynamic put)
 *
 * It is deliberately conservative about the OBJECT (only records a write when the
 * receiver's type is known), so it under-reports rather than inventing links.
 * Known blind spots: fully-dynamic field names, Database.* calls, JSON deserialize,
 * and managed classes whose Body isn't retrievable.
 */

export interface ApexFieldWrite {
    object: string;
    field: string;
}

const NOT_A_TYPE = new Set([
    "return", "new", "if", "else", "for", "while", "do", "try", "catch", "finally", "throw",
    "public", "private", "protected", "global", "static", "final", "void", "override", "virtual",
    "abstract", "transient", "with", "without", "sharing", "this", "super", "get", "set", "system",
    "insert", "update", "upsert", "delete", "undelete", "merge", "select", "from", "where",
    "and", "or", "not", "null", "true", "false", "instanceof", "in", "on", "case", "when"
]);

const COLLECTIONS = new Set(["list", "set", "map", "iterable"]);

/** Remove line/block comments. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Blank the contents of string literals (keep the quotes) so code regexes don't match inside them. */
function blankStrings(src: string): string {
    return src.replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/** Build a map of local variable name (lowercased) → SObject API name, from declarations. */
function collectVarTypes(code: string, defaultObject?: string): Map<string, string> {
    const vars = new Map<string, string>();
    const put = (name: string, type: string) => {
        const t = type.replace(/__[rR]$/, "");
        if (NOT_A_TYPE.has(type.toLowerCase()) || COLLECTIONS.has(type.toLowerCase())) return;
        vars.set(name.toLowerCase(), t);
    };

    // `Account acc`, `Contact c =`, `Account acc;`  — a Type followed by a name then =, ; or )
    const declRe = /\b([A-Z][A-Za-z0-9_]*(?:__[cC])?)\s+([A-Za-z_]\w*)\s*(?=[=;),])/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(code)) !== null) put(m[2], m[1]);

    // for-each element type: `for (Lead ld : leads)`
    const forRe = /\bfor\s*\(\s*([A-Za-z_]\w*(?:__[cC])?)\s+([A-Za-z_]\w*)\s*:/g;
    while ((m = forRe.exec(code)) !== null) put(m[2], m[1]);

    // Trigger context loop vars — `for (X x : Trigger.new)` gets the trigger's object.
    if (defaultObject) {
        const trigRe = /\bfor\s*\(\s*[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*:\s*[Tt]rigger\.(?:new|old)\b/g;
        while ((m = trigRe.exec(code)) !== null) vars.set(m[1].toLowerCase(), defaultObject);
    }
    return vars;
}

/** True when the body is an Apex test class (class-level @isTest, or contains testMethod). Such
 *  classes create records as test-data setup, which is process noise, so callers skip them. */
export function isApexTestClass(body: string): boolean {
    if (!body) return false;
    return /@\s*istest\b/i.test(body) || /\btestmethod\b/i.test(body);
}

/**
 * Find which OTHER Apex classes this body calls — `Class.method(...)` (static/inner) and
 * `new Class(...)` — restricted to `knownClasses` (real org classes) so we skip the standard
 * library and SObjects. This is the edge set for the call-chain: trigger → class → class → field.
 */
export function findApexCalls(body: string, knownClasses: Set<string>, self?: string): string[] {
    if (!body) return [];
    return callsFromCode(blankStrings(stripComments(body)), knownClasses, self);
}

/** Find the SObject fields written by an Apex body. `defaultObject` = the trigger's object, if any. */
export function findFieldWrites(body: string, opts?: { defaultObject?: string }): ApexFieldWrite[] {
    if (!body || body === "(hidden)") return [];
    const code = stripComments(body);
    return writesFromCode(code, blankStrings(code), opts?.defaultObject);
}

/**
 * Scan a body ONCE (comment-strip + string-blank done a single time) and return both its field
 * writes and its calls — the caller in the retrieval layer runs this per class/trigger, so doing
 * both from one clean avoids stripping every body twice.
 */
export function scanApexBody(
    body: string,
    opts: { knownClasses?: Set<string>; defaultObject?: string; self?: string }
): { writes: ApexFieldWrite[]; calls: string[] } {
    if (!body || body === "(hidden)") return { writes: [], calls: [] };
    const code = stripComments(body);
    const codeNoStr = blankStrings(code);
    return {
        writes: writesFromCode(code, codeNoStr, opts.defaultObject),
        calls: opts.knownClasses ? callsFromCode(codeNoStr, opts.knownClasses, opts.self) : []
    };
}

// ── Internals that take pre-cleaned code so the caller can strip once and reuse. ────────────────

function callsFromCode(codeNoStr: string, knownClasses: Set<string>, self?: string): string[] {
    const found = new Set<string>();
    const consider = (name: string) => {
        if (name && name !== self && knownClasses.has(name)) found.add(name);
    };
    let m: RegExpExecArray | null;
    const dotRe = /\b([A-Z][A-Za-z0-9_]*)\s*\./g; // static reference / call: `ClassName.`
    while ((m = dotRe.exec(codeNoStr)) !== null) consider(m[1]);
    const ctorRe = /\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g; // construction: `new ClassName(`
    while ((m = ctorRe.exec(codeNoStr)) !== null) consider(m[1]);
    return [...found];
}

function writesFromCode(code: string, codeNoStr: string, defaultObject?: string): ApexFieldWrite[] {
    const varTypes = collectVarTypes(codeNoStr, defaultObject);
    const out = new Map<string, ApexFieldWrite>();
    const add = (object?: string, field?: string) => {
        if (!object || !field || !/^[A-Za-z_]\w*$/.test(field)) return;
        if (NOT_A_TYPE.has(object.toLowerCase()) || COLLECTIONS.has(object.toLowerCase())) return;
        const key = `${object}.${field}`;
        if (!out.has(key)) out.set(key, { object, field });
    };
    let m: RegExpExecArray | null;

    // a. `var.Field = …`  (single '=', not ==, <=, >=, !=)
    const assignRe = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=(?!=)/g;
    while ((m = assignRe.exec(codeNoStr)) !== null) add(varTypes.get(m[1].toLowerCase()), m[2]);

    // b. `new Object(Field = …, Field2 = …)`
    const ctorRe = /\bnew\s+([A-Za-z_]\w*(?:__[cC])?)\s*\(([^)]*)\)/g;
    while ((m = ctorRe.exec(codeNoStr)) !== null) {
        const argRe = /([A-Za-z_]\w*)\s*=(?!=)/g;
        let a: RegExpExecArray | null;
        while ((a = argRe.exec(m[2])) !== null) add(m[1], a[1]);
    }

    // c. `var.put('Field', …)`  (strings intact in `code`)
    const putRe = /\b([A-Za-z_]\w*)\.put\(\s*'([A-Za-z_]\w*)'/g;
    while ((m = putRe.exec(code)) !== null) add(varTypes.get(m[1].toLowerCase()), m[2]);

    return [...out.values()];
}
