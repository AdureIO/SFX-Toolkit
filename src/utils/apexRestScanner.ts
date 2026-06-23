import * as vscode from "vscode";

export interface ApexRestResource {
  className: string;
  urlMapping: string;          // e.g. "/MyService/*"
  path: string;                // resolved REST path, e.g. "/services/apexrest/MyService/*"
  methods: string[];           // HTTP verbs exposed: GET, POST, PUT, PATCH, DELETE
}

const ANNOTATION_TO_VERB: Record<string, string> = {
  httpget: "GET",
  httppost: "POST",
  httpput: "PUT",
  httppatch: "PATCH",
  httpdelete: "DELETE"
};

/**
 * Scan the workspace's Apex classes for @RestResource services and the HTTP
 * verbs they expose, so the REST Explorer can list them as ready-to-call
 * endpoints. Best-effort, regex-based — no full Apex parse needed.
 */
export async function scanApexRestResources(): Promise<ApexRestResource[]> {
  let files: vscode.Uri[];
  try {
    files = await vscode.workspace.findFiles("**/classes/*.cls", "**/node_modules/**", 2000);
  } catch {
    return [];
  }

  const out: ApexRestResource[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    } catch {
      continue;
    }
    // @RestResource(urlMapping='/foo/*')  — quotes may be single or double.
    const m = /@RestResource\s*\(\s*urlMapping\s*=\s*['"]([^'"]+)['"]\s*\)/i.exec(text);
    if (!m) continue;
    const urlMapping = m[1].trim();

    // Collect the HTTP verbs from method annotations (@HttpGet etc.).
    const verbs = new Set<string>();
    const verbRe = /@(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\b/gi;
    let vm: RegExpExecArray | null;
    while ((vm = verbRe.exec(text)) !== null) {
      const verb = ANNOTATION_TO_VERB[vm[1].toLowerCase()];
      if (verb) verbs.add(verb);
    }

    const className = file.path.split("/").pop()?.replace(/\.cls$/i, "") ?? "ApexRest";
    const normalizedMapping = urlMapping.startsWith("/") ? urlMapping : `/${urlMapping}`;
    out.push({
      className,
      urlMapping: normalizedMapping,
      path: `/services/apexrest${normalizedMapping}`,
      methods: Array.from(verbs)
    });
  }
  out.sort((a, b) => a.className.localeCompare(b.className));
  return out;
}
