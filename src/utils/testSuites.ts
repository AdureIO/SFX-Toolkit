import * as fs from "fs";
import * as path from "path";

export interface TestSuite {
  name: string;
  testClassNames: string[];
}

interface SuitesFile {
  suites: TestSuite[];
}

function suitesFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".sfdx", "asfx", "test-suites.json");
}

export function loadTestSuites(workspaceRoot: string): TestSuite[] {
  try {
    const fp = suitesFilePath(workspaceRoot);
    if (!fs.existsSync(fp)) return [];
    const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as SuitesFile;
    return Array.isArray(raw?.suites) ? raw.suites : [];
  } catch {
    return [];
  }
}

function persistSuites(workspaceRoot: string, suites: TestSuite[]): void {
  const fp = suitesFilePath(workspaceRoot);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ suites }, null, 2), "utf8");
}

export function upsertTestSuite(workspaceRoot: string, suite: TestSuite): TestSuite[] {
  const suites = loadTestSuites(workspaceRoot);
  const idx = suites.findIndex((s) => s.name === suite.name);
  if (idx >= 0) suites[idx] = suite; else suites.push(suite);
  persistSuites(workspaceRoot, suites);
  return suites;
}

export function deleteTestSuite(workspaceRoot: string, name: string): TestSuite[] {
  const suites = loadTestSuites(workspaceRoot).filter((s) => s.name !== name);
  persistSuites(workspaceRoot, suites);
  return suites;
}
