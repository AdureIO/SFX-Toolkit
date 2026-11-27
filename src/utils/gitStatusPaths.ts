import { getPackageDirectories } from "../commands/deployMetadata";
import { runCommand } from "./commandRunner";

/** Run `git status --porcelain` and return paths filtered to SFDX package dirs. */
export async function runGitStatusSfdxPaths(workspaceRoot: string): Promise<string[]> {
  const out = await runCommand("git status --porcelain", workspaceRoot, undefined, false, undefined, 10000);
  const paths: string[] = [];
  const n = (s: string) => {
    let t = s.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).replace(/\\"/g, '"');
    return t.split("/").filter(Boolean).join("/");
  };
  for (const line of (out || "").split(/\r?\n/)) {
    if (line.length < 4) continue;
    const rest = line.substring(3).trim();
    if (rest.includes(" -> ")) {
      const [a, b] = rest.split(" -> ").map((x) => x.trim());
      const pa = n(a);
      const pb = n(b);
      if (pa) paths.push(pa);
      if (pb) paths.push(pb);
    } else {
      const p = n(rest);
      if (p) paths.push(p);
    }
  }
  const seen = new Set<string>();
  const all = paths.filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; });
  // `--porcelain` paths are relative to the repository root; the project may be a subfolder of it (multi-project workspaces).
  let prefix = "";
  try {
    const out2 = await runCommand("git rev-parse --show-prefix", workspaceRoot, undefined, false, undefined, 5000);
    const line = (out2 || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
    if (/^[^\s:*?"<>|]+\/$/.test(line)) prefix = line.replace(/\\/g, "/");
  } catch { /* not a repository: the status above failed already */ }
  const unique = prefix ? all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)) : all;
  const packageDirs = getPackageDirectories(workspaceRoot);
  return packageDirs.length > 0
    ? unique.filter((p) => packageDirs.some((dir) => {
        const d = dir.replace(/\\/g, "/").replace(/\/$/, "");
        return p === d || p.startsWith(d + "/");
      }))
    : unique;
}
