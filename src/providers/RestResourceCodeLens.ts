import * as vscode from "vscode";
import { RestExplorerPanelProvider } from "./RestExplorerPanelProvider";

/**
 * CodeLens on `@RestResource` Apex classes: a "Test <VERB> in REST Explorer" link on
 * each `@HttpGet/@HttpPost/…` method that opens the REST Explorer pre-filled with the
 * Apex REST URL (`/services/apexrest/<urlMapping>`) and the matching HTTP method.
 */
const VERBS: Record<string, string> = {
    httpget: "GET",
    httppost: "POST",
    httpput: "PUT",
    httppatch: "PATCH",
    httpdelete: "DELETE"
};

class RestResourceCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
        if (!doc.fileName.toLowerCase().endsWith(".cls")) return [];
        const text = doc.getText();
        const rr = /@RestResource\s*\(\s*urlMapping\s*=\s*'([^']+)'\s*\)/i.exec(text);
        if (!rr) return [];
        const mapping = rr[1].startsWith("/") ? rr[1] : "/" + rr[1];
        const url = ("/services/apexrest" + mapping).replace(/\/\*+$/, "");

        const lenses: vscode.CodeLens[] = [];
        for (const m of text.matchAll(/@(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\b/gi)) {
            const verb = VERBS[m[1].toLowerCase()];
            const pos = doc.positionAt(m.index ?? 0);
            lenses.push(
                new vscode.CodeLens(new vscode.Range(pos, pos), {
                    title: `$(globe) Test ${verb} in REST Explorer`,
                    command: "adure-sfx-toolkit.testRestResource",
                    arguments: [verb, url]
                })
            );
        }
        if (lenses.length === 0) {
            const pos = doc.positionAt(rr.index ?? 0);
            lenses.push(
                new vscode.CodeLens(new vscode.Range(pos, pos), {
                    title: "$(globe) Test in REST Explorer",
                    command: "adure-sfx-toolkit.testRestResource",
                    arguments: ["GET", url]
                })
            );
        }
        return lenses;
    }
}

export function registerRestResourceCodeLens(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ pattern: "**/*.cls" }, new RestResourceCodeLensProvider()),
        vscode.commands.registerCommand("adure-sfx-toolkit.testRestResource", (method: string, url: string) =>
            RestExplorerPanelProvider.show({ method, url })
        )
    );
}
