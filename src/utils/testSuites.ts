import * as fs from "fs";
import * as path from "path";

import { TestSuite, parseSuites, removeSuite, upsertSuite } from "./testSuitesPure";

export type { TestSuite } from "./testSuitesPure";

type Listener = (workspaceRoot: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to suite changes made through this store (the Deploy panel and the Center share one file per project). */
export function onDidChangeTestSuites(listener: Listener): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => void listeners.delete(listener) };
}

function fire(workspaceRoot: string): void {
  for (const l of [...listeners]) {
    try { l(workspaceRoot); } catch { /* a listener never breaks a save */ }
  }
}

function suitesFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".sfdx", "asfx", "test-suites.json");
}

export function loadTestSuites(workspaceRoot: string): TestSuite[] {
  try {
    const fp = suitesFilePath(workspaceRoot);
    if (!fs.existsSync(fp)) return [];
    return parseSuites(JSON.parse(fs.readFileSync(fp, "utf8")));
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
  const suites = upsertSuite(loadTestSuites(workspaceRoot), suite);
  persistSuites(workspaceRoot, suites);
  fire(workspaceRoot);
  return suites;
}

export function deleteTestSuite(workspaceRoot: string, name: string): TestSuite[] {
  const suites = removeSuite(loadTestSuites(workspaceRoot), name);
  persistSuites(workspaceRoot, suites);
  fire(workspaceRoot);
  return suites;
}
