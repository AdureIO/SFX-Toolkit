/**
 * Minimal in-process stand-in for the `vscode` module so host-side utils (which
 * import vscode for config / output channels / workspace folders) can be unit
 * tested under plain mocha. Import this FIRST in a test file.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require("module");
import * as path from "path";

export const vscodeStubState: {
	workspaceFolders: { uri: { fsPath: string; scheme: string; toString(): string }; name: string; index: number }[] | undefined;
	config: Record<string, unknown>;
} = { workspaceFolders: undefined, config: {} };

export function setWorkspaceFolders(dirs: string[]): void {
	vscodeStubState.workspaceFolders = dirs.map((d, i) => ({ uri: fileUri(d), name: path.basename(d), index: i }));
}

function fileUri(p: string) {
	return { fsPath: p, scheme: "file", path: p, toString: () => `file://${p}` };
}

class EventEmitter<T> {
	private listeners: ((e: T) => void)[] = [];
	event = (l: (e: T) => void) => {
		this.listeners.push(l);
		return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
	};
	fire(e: T): void {
		for (const l of this.listeners) l(e);
	}
	dispose(): void {
		this.listeners = [];
	}
}

class Disposable {
	constructor(private readonly fn?: () => void) {}
	dispose(): void {
		this.fn?.();
	}
}

const noopChannel = { appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} };

const fake = {
	window: {
		createOutputChannel: () => noopChannel,
		createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "", command: undefined }),
		showWarningMessage: async () => undefined,
		showInformationMessage: async () => undefined,
		showErrorMessage: async () => undefined,
	},
	workspace: {
		get workspaceFolders() {
			return vscodeStubState.workspaceFolders;
		},
		getConfiguration: () => ({
			get: (key: string, def?: unknown) => (key in vscodeStubState.config ? vscodeStubState.config[key] : def),
		}),
		createFileSystemWatcher: () => ({
			onDidCreate: () => new Disposable(),
			onDidChange: () => new Disposable(),
			onDidDelete: () => new Disposable(),
			dispose() {},
		}),
		textDocuments: [] as unknown[],
	},
	commands: { executeCommand: async () => undefined, registerCommand: () => new Disposable() },
	extensions: { getExtension: () => undefined },
	Uri: { file: fileUri, parse: (s: string) => fileUri(s.replace(/^file:\/\//, "")) },
	EventEmitter,
	Disposable,
	RelativePattern: class {
		constructor(public base: unknown, public pattern: string) {}
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
};

const STUB_ID = path.join(__dirname, "__vscode_stub__.js");
if (!require.cache[STUB_ID]) {
	const m = new Module(STUB_ID);
	m.filename = STUB_ID;
	m.loaded = true;
	m.exports = fake;
	require.cache[STUB_ID] = m;
	const origResolve = Module._resolveFilename;
	Module._resolveFilename = function (request: string, ...rest: unknown[]) {
		if (request === "vscode") return STUB_ID;
		return origResolve.call(this, request, ...rest);
	};
}
