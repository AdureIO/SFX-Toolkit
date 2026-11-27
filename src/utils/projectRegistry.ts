/**
 * Registry of the Salesforce projects (SFDX and MDAPI) in the open workspace folders, and the
 * ACTIVE project: the one containing the active editor's file (like Git picks a repository),
 * else the last active one (persisted in workspaceState), else the first discovered.
 *
 * Before `initProjectRegistry` runs (unit tests) the project list is discovered on every
 * call, so the helpers in projectUtils stay correct without any lifecycle.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { isMdapiFolder } from "./mdapiFolder";
import {
	DiscoveryFs,
	SfProject,
	discoverProjects,
	isProjectMarkerPath,
	projectOfFileIn,
	samePath,
	sameProjects,
	selectActiveProjectIn,
} from "./projectDiscoveryPure";

export type { SfProject } from "./projectDiscoveryPure";

/** workspaceState key holding the last active project dir. */
export const ACTIVE_PROJECT_STATE_KEY = "asfx.activeProject";
const RESCAN_DEBOUNCE_MS = 500;

const realFs: DiscoveryFs = {
	readdir: (dir) => {
		try {
			return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	},
	exists: (p) => fs.existsSync(p),
	isMdapiFolder,
};

const projectsEmitter = new vscode.EventEmitter<void>();
const activeEmitter = new vscode.EventEmitter<SfProject | undefined>();
export const onDidChangeProjects: vscode.Event<void> = projectsEmitter.event;
export const onDidChangeActiveProject: vscode.Event<SfProject | undefined> = activeEmitter.event;

let initialised = false;
let state: vscode.Memento | undefined;
let known: SfProject[] = [];
let active: SfProject | undefined;
let lastActiveDir: string | undefined;

function workspaceFolderPaths(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function activeEditorFile(): string | undefined {
	const doc = vscode.window?.activeTextEditor?.document;
	return doc && doc.uri.scheme === "file" ? doc.uri.fsPath : undefined;
}

/** Every discovered project, sorted by workspace-folder order, then path. */
export function projects(): SfProject[] {
	return initialised ? known : discoverProjects(workspaceFolderPaths(), realFs);
}

/** The deepest discovered project containing `file`. */
export function projectOfFile(file: string): SfProject | undefined {
	return projectOfFileIn(projects(), file);
}

/** The active project (see the module comment). */
export function activeProject(): SfProject | undefined {
	if (initialised) return active;
	return selectActiveProjectIn(projects(), undefined, undefined);
}

function persist(dir: string | undefined): void {
	lastActiveDir = dir;
	try {
		void state?.update(ACTIVE_PROJECT_STATE_KEY, dir);
	} catch {
		/* persistence is best effort */
	}
}

/** Recompute the active project; fires and persists when it changed. */
function reselect(preferFile: string | undefined): void {
	const next = selectActiveProjectIn(known, preferFile, lastActiveDir);
	if (samePath(next?.dir, active?.dir) && next?.kind === active?.kind) {
		active = next;
		return;
	}
	active = next;
	if (next) persist(next.dir);
	activeEmitter.fire(next);
}

/** Switch the active project (status bar picker). Ignored for a dir that is not a discovered project. */
export function setActiveProject(dir: string): void {
	const p = projects().find((x) => samePath(x.dir, dir));
	if (!p) return;
	if (!initialised) return;
	if (samePath(active?.dir, p.dir)) return;
	active = p;
	persist(p.dir);
	activeEmitter.fire(p);
}

/** Re-discover now. Fires onDidChangeProjects (and onDidChangeActiveProject) only on a real change. */
export function rescanProjects(): void {
	const next = discoverProjects(workspaceFolderPaths(), realFs);
	if (sameProjects(next, known)) return;
	known = next;
	projectsEmitter.fire();
	reselect(activeEditorFile());
}

function onEditorChanged(editor: vscode.TextEditor | undefined): void {
	const doc = editor?.document;
	// Untitled / output / webview documents keep the current project.
	if (!doc || doc.uri.scheme !== "file") return;
	const hit = projectOfFileIn(known, doc.uri.fsPath);
	if (!hit || samePath(hit.dir, active?.dir)) return;
	active = hit;
	persist(hit.dir);
	activeEmitter.fire(hit);
}

/** Folder-relative path segments of `fsPath`, or undefined when it is in no workspace folder. */
function relSegments(fsPath: string): string[] | undefined {
	for (const f of workspaceFolderPaths()) {
		const rel = path.relative(f, fsPath);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep);
	}
	return undefined;
}

/**
 * Start discovery: initial scan, the editor/workspace-folder listeners and the marker-file
 * watcher. Call once, first thing in activate().
 */
export function initProjectRegistry(context: vscode.ExtensionContext): void {
	state = context.workspaceState;
	lastActiveDir = state.get<string>(ACTIVE_PROJECT_STATE_KEY);
	initialised = true;
	known = discoverProjects(workspaceFolderPaths(), realFs);
	active = selectActiveProjectIn(known, activeEditorFile(), lastActiveDir);
	if (active) persist(active.dir);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const scheduleRescan = (uri: vscode.Uri) => {
		if (uri.scheme !== "file") return;
		const segs = relSegments(uri.fsPath);
		if (!segs || !isProjectMarkerPath(segs)) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			rescanProjects();
		}, RESCAN_DEBOUNCE_MS);
	};
	const watcher = vscode.workspace.createFileSystemWatcher("**/{sfdx-project.json,package.xml}");

	context.subscriptions.push(
		projectsEmitter,
		activeEmitter,
		watcher,
		watcher.onDidCreate(scheduleRescan),
		watcher.onDidChange(scheduleRescan),
		watcher.onDidDelete(scheduleRescan),
		vscode.window.onDidChangeActiveTextEditor(onEditorChanged),
		vscode.workspace.onDidChangeWorkspaceFolders(() => rescanProjects()),
		new vscode.Disposable(() => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			initialised = false;
			known = [];
			active = undefined;
		})
	);
}
