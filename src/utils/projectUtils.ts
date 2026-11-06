import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Message shown when workspace is not an SFDX project. */
export const NOT_SFDX_PROJECT_MESSAGE = 'Open an SFDX project (folder containing sfdx-project.json) to use Salesforce features.';

export function isSalesforceProject(): boolean {
    if (!vscode.workspace.workspaceFolders) {
        return false;
    }

    for (const folder of vscode.workspace.workspaceFolders) {
        const projectJsonPath = path.join(folder.uri.fsPath, 'sfdx-project.json');
        if (fs.existsSync(projectJsonPath)) {
            return true;
        }
    }

    return false;
}

/**
 * Root of the primary SFDX project: the first workspace folder containing
 * sfdx-project.json (multi-root workspaces may list a non-SFDX folder first),
 * else the first folder. This is the project whose default org `null` means.
 */
export function primaryProjectRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
        if (fs.existsSync(path.join(folder.uri.fsPath, 'sfdx-project.json'))) return folder.uri.fsPath;
    }
    return folders[0]?.uri.fsPath;
}

/**
 * Walk up from a file path to the nearest directory containing sfdx-project.json.
 * Lets nested/sub-projects (e.g. billing/force-app/...) resolve their own org/config
 * instead of always using the workspace root. Returns null if none is found.
 */
export function findSfdxProjectDir(filePath: string): string | null {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 100; i++) {
        if (fs.existsSync(path.join(dir, 'sfdx-project.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

const MDAPI_PACKAGE_XMLNS = /<Package\s[^>]*xmlns\s*=\s*["']http:\/\/soap\.sforce\.com\/2006\/04\/metadata["']/;

/** Shown when a source-based feature is used in an MDAPI-format project. */
export const MDAPI_PROJECT_MESSAGE = 'This needs an SFDX-format project. This is an MDAPI project (src/package.xml).';
export const CONVERT_MDAPI_COMMAND = 'adure-sfx-toolkit.convertMdapiToSfdx';

/** True when `dir` or any ancestor contains sfdx-project.json. */
export function hasSfdxProjectUpward(dir: string): boolean {
    let d = dir;
    for (let i = 0; i < 100; i++) {
        if (fs.existsSync(path.join(d, 'sfdx-project.json'))) return true;
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
    }
    return false;
}

/**
 * A legacy Metadata API (MDAPI) project folder: `<dir>/src/package.xml` is a Metadata
 * `<Package xmlns="http://soap.sforce.com/2006/04/metadata">` and there is no
 * sfdx-project.json in `dir` or any ancestor.
 */
export function isMdapiFolder(dir: string): boolean {
    try {
        const pkg = path.join(dir, 'src', 'package.xml');
        if (!fs.existsSync(pkg)) return false;
        const fd = fs.openSync(pkg, 'r');
        let head: string;
        try {
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.toString('utf8', 0, n);
        } finally {
            fs.closeSync(fd);
        }
        if (!MDAPI_PACKAGE_XMLNS.test(head)) return false;
        return !hasSfdxProjectUpward(dir);
    } catch {
        return false;
    }
}

/** Workspace folders that are MDAPI projects. */
export function mdapiFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
        .map((f) => f.uri.fsPath)
        .filter((d) => isMdapiFolder(d));
}

/** At least one workspace folder is an MDAPI project and none is an SFDX project (mixed stays SFDX). */
export function isMdapiProject(): boolean {
    return !isSalesforceProject() && mdapiFolders().length > 0;
}

/** SFDX or MDAPI: org-based features work. Source-based features need isSalesforceProject(). */
export function isWorkspaceUsable(): boolean {
    return isSalesforceProject() || isMdapiProject();
}

const CONTEXT_KEY = 'adure-sfx-toolkit:isSalesforceProject';
const MDAPI_CONTEXT_KEY = 'adure-sfx-toolkit:isMdapiProject';
const USABLE_CONTEXT_KEY = 'adure-sfx-toolkit:isUsableProject';

/** Update the context keys so views/commands can use "when" clauses. Call on activation and on workspace folder change. */
export function updateSalesforceProjectContext(): void {
    const sfdx = isSalesforceProject();
    const mdapi = !sfdx && mdapiFolders().length > 0;
    vscode.commands.executeCommand('setContext', CONTEXT_KEY, sfdx);
    vscode.commands.executeCommand('setContext', MDAPI_CONTEXT_KEY, mdapi);
    vscode.commands.executeCommand('setContext', USABLE_CONTEXT_KEY, sfdx || mdapi);
}
