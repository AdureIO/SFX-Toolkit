/**
 * Interpret a Salesforce deploy/push failure into plain-language problems with
 * suggested fixes. Pure + testable (no `vscode` import) so it can back a webview
 * and be unit-tested against real error strings.
 *
 * Input is the normalized set of component failures (from the Metadata API deploy
 * result) plus/or a top-level error string (CLI/auth/project errors). Output keeps
 * the original `problem` text on every issue so the panel can always reveal the raw error.
 */

import type { ApiComponentFailure } from "./deployDiagnostics";

export interface DeployIssue {
    component?: string; // fullName, e.g. MyClass
    type?: string; // componentType, e.g. ApexClass
    file?: string; // fileName as reported (relative)
    line?: number;
    column?: number;
    category: string; // short bucket, e.g. "Missing field"
    problem: string; // the ORIGINAL error text — always shown as the primary content
    explanation?: string; // optional friendly note, ONLY when we recognise the error
    suggestion?: string; // how to fix, when known
}

export interface InterpretedDeploy {
    title: string; // e.g. "Push failed — 3 problems"
    headline?: string; // interpreted top-level message, when there is one
    issues: DeployIssue[];
    warnings: string[]; // non-fatal CLI warnings worth surfacing
    raw: string; // full original text, for "show original"
    counts: { errors: number };
}

interface Rule {
    test: RegExp;
    category: string;
    /** May reference capture groups from `test` via $1, $2… in explanation/suggestion. */
    explanation: string;
    suggestion?: string;
}

// Ordered most-specific → most-general. First match wins per problem.
const RULES: Rule[] = [
    {
        test: /Expected source files for type|ExpectedSourceFilesError/i,
        category: "Incomplete component",
        explanation:
            "A component is missing part of its source — a '-meta.xml' exists without its paired source file (or the other way round), so the CLI won't deploy it.",
        suggestion:
            "Restore the missing file for that component (e.g. the .cls next to its .cls-meta.xml), or delete the orphaned -meta.xml, then push again."
    },
    {
        test: /dependent class is invalid and needs recompilation/i,
        category: "Cascading compile error",
        explanation:
            "This class didn't compile because another class it depends on has an error. It's a knock-on failure, not the real cause.",
        suggestion: "Fix the root class that actually fails to compile — this one usually resolves once that's green."
    },
    {
        test: /(?:No such column|Invalid field|No such field|Field .* does not exist)[:\s]*'?([A-Za-z0-9_.]+)'?/i,
        category: "Unknown field",
        explanation: "References a field ($1) that doesn't exist on the target org.",
        suggestion: "Check the API name/namespace, or deploy the field before the component that uses it."
    },
    {
        test: /Variable does not exist:\s*([A-Za-z0-9_]+)/i,
        category: "Unknown variable / field",
        explanation: "Apex refers to '$1', which isn't declared or isn't a field on the object in scope.",
        suggestion: "Check the spelling and that the field/variable exists and is spelled with the right API name."
    },
    {
        test: /Method does not exist or incorrect signature[^\n]*?\b([A-Za-z0-9_]+)\s*\(/i,
        category: "Bad method call",
        explanation: "Calls '$1(...)' with a name or argument list that doesn't match any method.",
        suggestion: "Verify the method name, argument count and types (including namespace) against the definition."
    },
    {
        test: /Type is not visible|Invalid type:\s*([A-Za-z0-9_.]+)|Type .* does not exist/i,
        category: "Unknown type",
        explanation: "References a class/type ($1) the target org can't see.",
        suggestion: "Deploy the missing type first, or check the namespace and access modifiers (public/global)."
    },
    {
        test: /(?:duplicate value found|DUPLICATE_DEVELOPER_NAME|already been used)/i,
        category: "Duplicate name",
        explanation: "A component with this name/developer name already exists in the org.",
        suggestion: "Rename the new component, or retrieve and update the existing one instead of creating a duplicate."
    },
    {
        test: /INVALID_CROSS_REFERENCE_KEY|invalid cross reference id/i,
        category: "Missing reference",
        explanation: "Points at a record or metadata id that doesn't exist in the target org.",
        suggestion: "Deploy the referenced metadata first, or fix the reference to something present in this org."
    },
    {
        test: /(INSUFFICIENT_ACCESS|insufficient access rights|not writeable|is not visible|FIELD_INTEGRITY_EXCEPTION)/i,
        category: "Permissions / FLS",
        explanation: "The deploying user can't see or write something this component needs (field-level security or object permissions).",
        suggestion: "Grant the field/object permission on a permission set or profile, then redeploy."
    },
    {
        test: /(code coverage|Average test coverage|test coverage requirement)/i,
        category: "Test coverage",
        explanation: "Apex code coverage is below the 75% required to deploy to this org.",
        suggestion: "Add or fix tests so overall coverage is ≥ 75% (production and some orgs enforce this)."
    },
    {
        test: /(Test .*failed|System\.[A-Za-z]+Exception|Assertion Failed|methodName=)/i,
        category: "Failing test",
        explanation: "An Apex test ran during deploy and failed.",
        suggestion: "Open the test, reproduce the failure, and fix the assertion or the code under test."
    },
    {
        test: /(conflicts? (were )?detected|source conflict|remote changes|would be overwritten)/i,
        category: "Source conflict",
        explanation: "The org has changes that conflict with your local source — the deploy was blocked to avoid overwriting them.",
        suggestion: "Review the remote changes, then push with 'Force Push' (deploys your version with --ignore-conflicts)."
    },
    {
        test: /Required fields are missing:\s*\[([^\]]+)\]|Missing required field/i,
        category: "Missing required field",
        explanation: "A required field ($1) wasn't provided on this metadata.",
        suggestion: "Add the missing field/value to the component's source and redeploy."
    },
    {
        test: /(LIMIT_EXCEEDED|too many|exceeded the limit)/i,
        category: "Org limit",
        explanation: "The deploy hit an org limit.",
        suggestion: "Reduce the size/scope of the change, or clean up unused metadata, then retry."
    },
    {
        test: /(timed out|timeout|TIMED_OUT)/i,
        category: "Timeout",
        explanation: "The deploy didn't finish in time.",
        suggestion: "Retry — if it keeps timing out, deploy fewer components at once or check the org's status."
    },
    {
        test: /(isomorphic-git|Index file is empty|\.git[\\/]index)/i,
        category: "Git index error",
        explanation: "The CLI's source-tracking couldn't read your repo's git index — it's empty or corrupt (.git/index).",
        suggestion: "Rebuild the index with `git reset` (or delete .git/index and run `git reset`), then push again."
    },
    {
        test: /An internal error caused this command to fail|INTERNAL_ERROR/i,
        category: "CLI internal error",
        explanation: "The Salesforce CLI itself threw an internal error before/while deploying — this usually isn't your metadata.",
        suggestion: "Check the exact message below; retry, and if it persists update the CLI (`sf update`) or clear source-tracking state."
    }
];

/** Fill $1, $2… in a template from a RegExp match. */
function fill(template: string, m: RegExpExecArray): string {
    return template.replace(/\$(\d)/g, (_s, d) => (m[Number(d)] ?? "").toString().trim() || "it");
}

function interpretProblem(problem: string): { category: string; explanation?: string; suggestion?: string; matched: boolean } {
    for (const rule of RULES) {
        const m = rule.test.exec(problem);
        if (m) {
            return {
                category: rule.category,
                explanation: fill(rule.explanation, m),
                suggestion: rule.suggestion ? fill(rule.suggestion, m) : undefined,
                matched: true
            };
        }
    }
    // Unrecognised → no filler. The real message IS the content; just tag it neutrally.
    return { category: "Error", matched: false };
}

/** The SF CLI (`--json`) reports fatal errors as a JSON object. Pull out the useful bits. */
function parseCliError(raw: string): { message?: string; name?: string; warnings?: string[] } {
    if (!raw) return {};
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return {};
    try {
        const obj = JSON.parse(raw.slice(start, end + 1)) as { message?: unknown; name?: unknown; code?: unknown; warnings?: unknown };
        const message = typeof obj.message === "string" ? obj.message : undefined;
        const name = typeof obj.name === "string" ? obj.name : typeof obj.code === "string" ? obj.code : undefined;
        const warnings = Array.isArray(obj.warnings) ? obj.warnings.filter((w): w is string => typeof w === "string") : undefined;
        return { message, name, warnings };
    } catch {
        return {};
    }
}

/** A leading "path/to/File.ext: message" → the file path, for a click-through. */
function fileFromMessage(msg: string): string | undefined {
    const m = /^\s*([^\s:"]+\.[A-Za-z][\w.-]*)\s*:/.exec(msg);
    return m ? m[1] : undefined;
}

const shortName = (file?: string, full?: string): string | undefined => {
    if (full) return full;
    if (!file) return undefined;
    const base = file.split(/[\\/]/).pop() ?? file;
    return base.replace(/\.[^.]+$/, "");
};

/** Turn structured component failures + an optional top-level error into an interpreted report. */
export function interpretDeployFailure(input: { failures?: ApiComponentFailure[]; topError?: string; raw: string; warnings?: string[] }): InterpretedDeploy {
    const failures = (input.failures ?? []).filter((f) => f && (f.problem || f.fullName));
    const issues: DeployIssue[] = failures.map((f) => {
        const problem = (f.problem ?? "").trim() || "(no message)";
        const i = interpretProblem(problem);
        return {
            component: shortName(f.fileName, f.fullName),
            type: f.componentType,
            file: f.fileName,
            line: f.lineNumber,
            column: f.columnNumber,
            category: i.category,
            problem,
            explanation: i.explanation,
            suggestion: i.suggestion
        };
    });

    // The CLI reports fatal (non-component) failures as a JSON blob — recover its message/name/warnings.
    const cli = parseCliError(input.raw ?? "");
    const warnings = (input.warnings && input.warnings.length ? input.warnings : cli.warnings) ?? [];
    const topRaw = (input.topError && input.topError.trim()) || cli.message || "";

    let headline: string | undefined;
    if (topRaw) {
        const i = interpretProblem(topRaw);
        const category = i.matched ? i.category : (cli.name ? cli.name.replace(/Error$/, "").trim() || "Error" : "Error");
        // A headline only when we actually recognise the error — never vague filler.
        headline = i.matched && i.explanation ? `${i.explanation}${i.suggestion ? ` — ${i.suggestion}` : ""}` : undefined;
        // If there were no per-component failures, surface the top error as the single issue.
        if (!issues.length) {
            issues.push({
                category,
                problem: topRaw,
                explanation: i.explanation,
                suggestion: i.suggestion,
                file: fileFromMessage(topRaw)
            });
        }
    }

    const n = issues.length;
    const title = n ? `Push failed — ${n} problem${n === 1 ? "" : "s"}` : "Push failed";
    return { title, headline, issues, warnings, raw: input.raw, counts: { errors: n } };
}
