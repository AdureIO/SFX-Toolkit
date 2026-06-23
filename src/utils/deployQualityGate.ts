import * as fs from "fs";
import * as path from "path";

export interface QualityViolation {
  relPath: string;
  line: number;
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
}

const APEX_EXTS = new Set([".cls", ".trigger", ".apex"]);

/** Salesforce record ID: starts with 3-digit key prefix, total 15 or 18 alphanumeric chars. */
const SF_RECORD_ID = /['"](\d{3}[A-Za-z0-9]{12}|\d{3}[A-Za-z0-9]{15})['"]/g;

function collectApexFiles(absPath: string, out: string[]): void {
  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); } catch { return; }
  if (stat.isFile()) {
    if (APEX_EXTS.has(path.extname(absPath).toLowerCase())) out.push(absPath);
    return;
  }
  if (stat.isDirectory()) {
    let entries: string[];
    try { entries = fs.readdirSync(absPath); } catch { return; }
    for (const e of entries) collectApexFiles(path.join(absPath, e), out);
  }
}

/**
 * Scan selected source paths for common Apex quality issues:
 * - DEBUG_STATEMENT: System.debug() calls
 * - HARDCODED_ID: Salesforce record IDs in string literals
 * - DML_IN_LOOP: SOQL/DML inside a for/while loop
 * - TODO_FIXME: TODO or FIXME comments
 */
export async function runQualityGate(
  sourcePaths: string[],
  workspaceRoot: string
): Promise<QualityViolation[]> {
  const violations: QualityViolation[] = [];
  const files: string[] = [];

  for (const sp of sourcePaths) {
    const abs = path.isAbsolute(sp) ? sp : path.join(workspaceRoot, sp);
    collectApexFiles(abs, files);
  }

  for (const absFile of files) {
    let content: string;
    try { content = fs.readFileSync(absFile, "utf8"); } catch { continue; }

    const relPath = path.relative(workspaceRoot, absFile).replace(/\\/g, "/");
    const lines = content.split(/\r?\n/);
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const lineNum = i + 1;

      // ── Block comment tracking ──────────────────────────────────────────────
      if (inBlockComment) {
        if (/\bTODO\b|\bFIXME\b/i.test(raw)) {
          violations.push({ relPath, line: lineNum, severity: "info", rule: "TODO_FIXME",
            message: "TODO/FIXME in comment — review before client delivery" });
        }
        if (raw.includes("*/")) inBlockComment = false;
        continue;
      }
      if (raw.includes("/*") && !raw.includes("*/")) {
        inBlockComment = true;
        if (/\bTODO\b|\bFIXME\b/i.test(raw)) {
          violations.push({ relPath, line: lineNum, severity: "info", rule: "TODO_FIXME",
            message: "TODO/FIXME in comment — review before client delivery" });
        }
        continue;
      }

      // ── Split line comment off code ─────────────────────────────────────────
      const lcIdx = raw.indexOf("//");
      const code    = lcIdx >= 0 ? raw.substring(0, lcIdx) : raw;
      const comment = lcIdx >= 0 ? raw.substring(lcIdx) : "";

      // ── TODO / FIXME in line comment ────────────────────────────────────────
      if (/\bTODO\b|\bFIXME\b/i.test(comment)) {
        violations.push({ relPath, line: lineNum, severity: "info", rule: "TODO_FIXME",
          message: `${/TODO/i.test(comment) ? "TODO" : "FIXME"} comment — review before client delivery` });
      }

      // ── System.debug() ──────────────────────────────────────────────────────
      if (/\bSystem\s*\.\s*debug\s*\(/.test(code)) {
        violations.push({ relPath, line: lineNum, severity: "warning", rule: "DEBUG_STATEMENT",
          message: "System.debug() found — remove before production deployment" });
      }

      // ── Hardcoded Salesforce record ID ──────────────────────────────────────
      SF_RECORD_ID.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SF_RECORD_ID.exec(code)) !== null) {
        violations.push({ relPath, line: lineNum, severity: "error", rule: "HARDCODED_ID",
          message: `Possible hardcoded Salesforce ID "${m[1]}" — use Custom Labels or Custom Settings instead` });
      }

      // ── SOQL / DML inside a loop ────────────────────────────────────────────
      if (
        /\[\s*SELECT\b/i.test(code) ||
        /\bDatabase\s*\.\s*(query|queryWithBinds|insert|update|delete|upsert|merge)\s*\(/i.test(code)
      ) {
        for (let j = Math.max(0, i - 14); j < i; j++) {
          const prev = lines[j];
          if (/^\s*(\/\/|\/\*)/.test(prev.trim())) continue; // skip comment lines
          if (/\bfor\s*\(/.test(prev) || /\bwhile\s*\(/.test(prev)) {
            violations.push({ relPath, line: lineNum, severity: "error", rule: "DML_IN_LOOP",
              message: "SOQL/DML inside a loop — will cause governor limit violations in bulk operations" });
            break;
          }
        }
      }
    }
  }

  // Sort: errors first, then warnings, then info; within same severity: file → line
  violations.sort((a, b) => {
    const o: Record<string, number> = { error: 0, warning: 1, info: 2 };
    return (o[a.severity] - o[b.severity]) || a.relPath.localeCompare(b.relPath) || a.line - b.line;
  });

  return violations;
}
