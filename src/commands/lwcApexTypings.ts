import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { findAuraEnabledMethods, typingsForClass } from "../utils/apexAuraMethods";
import { reportError } from "../utils/reportError";
import { Logger } from "../utils/outputChannel";

/**
 * Generate typed `.d.ts` declarations for `@salesforce/apex/<Class>.<method>` imports.
 *
 * Salesforce's own generated typings declare every parameter and the return value as `any`. We
 * emit the same module names with the REAL types derived from each `@AuraEnabled` signature, plus
 * the Apex signature as a doc comment, so hovering and completing an imported Apex method in an
 * LWC shows something useful.
 *
 * Written to `.sfdx/typings/lwc/apex-asfx/` (our own folder — we never fight the Salesforce
 * extension over its generated files) and referenced from the LWC `jsconfig.json`.
 */

const OUT_DIR = path.join(".sfdx", "typings", "lwc", "apex-asfx");

export async function generateLwcApexTypings(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        vscode.window.showErrorMessage("Open a Salesforce project first.");
        return;
    }
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Generating LWC Apex typings…" },
            async () => {
                const files = await vscode.workspace.findFiles("**/*.cls", "**/node_modules/**");
                const outDir = path.join(root, OUT_DIR);
                fs.mkdirSync(outDir, { recursive: true });

                let written = 0;
                let methods = 0;
                for (const file of files) {
                    const className = path.basename(file.fsPath, ".cls");
                    const source = fs.readFileSync(file.fsPath, "utf8");
                    const body = typingsForClass(className, source);
                    if (!body) continue;
                    fs.writeFileSync(path.join(outDir, `${className}.d.ts`), body, "utf8");
                    written++;
                    methods += findAuraEnabledMethods(source).length;
                }

                Logger.info(`LWC Apex typings: ${written} class(es), ${methods} method(s) → ${OUT_DIR}`);
                vscode.window.showInformationMessage(
                    written
                        ? `Generated typings for ${methods} @AuraEnabled method(s) across ${written} class(es).`
                        : "No @AuraEnabled methods found."
                );
            }
        );
    } catch (error) {
        reportError({ operation: "Generate LWC Apex typings", error });
    }
}
