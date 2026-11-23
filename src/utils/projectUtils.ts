import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { hasSfdxProjectUpward, isMdapiFolder } from './mdapiFolder';
import { activeProject, projectOfFile, projects } from './projectRegistry';

/** Message shown when workspace is not an SFDX project. */
export const NOT_SFDX_PROJECT_MESSAGE = 'Open an SFDX project (folder containing sfdx-project.json) to use Salesforce features.';

/** Any SFDX project (sfdx-project.json at a workspace root or up to 2 levels below) is open. */
export function isSalesforceProject(): boolean {
    return projects().some((p) => p.kind === 'sfdx');
}

/**
 * Root of the ACTIVE project (the one following the active editor, or picked in the status
 * bar), else the first workspace folder. This is the project whose default org `null` means.
 */
export function primaryProjectRoot(): string | undefined {
    return activeProject()?.dir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

/** The project dir a file belongs to: nearest sfdx-project.json upward, else the discovered project containing it. */
export function projectDirOfFile(filePath: string): string | undefined {
    return findSfdxProjectDir(filePath) ?? projectOfFile(filePath)?.dir;
}

/** Shown when a source-based feature is used in an MDAPI-format project. */
export const MDAPI_PROJECT_MESSAGE = 'This needs an SFDX-format project. This is an MDAPI project (src/package.xml).';
export const CONVERT_MDAPI_COMMAND = 'adure-sfx-toolkit.convertMdapiToSfdx';

export { hasSfdxProjectUpward, isMdapiFolder };

/** Dirs of the discovered MDAPI projects. */
export function mdapiFolders(): string[] {
    return projects().filter((p) => p.kind === 'mdapi').map((p) => p.dir);
}

/** The active project is an MDAPI project. */
export function isMdapiProject(): boolean {
    return activeProject()?.kind === 'mdapi';
}

/** Any SFDX or MDAPI project is discovered: org-based features work. Source-based features need an active SFDX project. */
export function isWorkspaceUsable(): boolean {
    return projects().length > 0;
}

const CONTEXT_KEY = 'adure-sfx-toolkit:isSalesforceProject';
const MDAPI_CONTEXT_KEY = 'adure-sfx-toolkit:isMdapiProject';
const USABLE_CONTEXT_KEY = 'adure-sfx-toolkit:isUsableProject';
const MULTIPLE_CONTEXT_KEY = 'adure-sfx-toolkit:multipleProjects';
const ACTIVE_SFDX_CONTEXT_KEY = 'adure-sfx-toolkit:activeProjectIsSfdx';

/** Update the context keys so views/commands can use "when" clauses. Call on activation and on project / active-project changes. */
export function updateSalesforceProjectContext(): void {
    const all = projects();
    const set = (key: string, value: boolean) => vscode.commands.executeCommand('setContext', key, value);
    set(CONTEXT_KEY, all.some((p) => p.kind === 'sfdx'));
    set(MDAPI_CONTEXT_KEY, isMdapiProject());
    set(USABLE_CONTEXT_KEY, all.length > 0);
    set(MULTIPLE_CONTEXT_KEY, all.length > 1);
    set(ACTIVE_SFDX_CONTEXT_KEY, activeProject()?.kind === 'sfdx');
}
