import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { executeAnonymousApex, getAnonymousApexOrgList } from "../commands/executeAnonymous";
import { isSalesforceProject } from "../utils/projectUtils";

const BUFFER_RELATIVE_PATH = ".vscode/anon-apex-buffer.apex";
const ASFX_DIR = ".sfdx/asfx";
const APEX_LAST_FILE = "apex-last.txt";
const APEX_HISTORY_FILE = "apex-history.json";
const APEX_HISTORY_MAX = 10;

export class AnonymousApexViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _messageListener?: vscode.Disposable;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  private getBufferUri(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return undefined;
    return vscode.Uri.joinPath(root, BUFFER_RELATIVE_PATH);
  }

  private async readBuffer(): Promise<string> {
    const uri = this.getBufferUri();
    if (!uri) return "";
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }

  private async writeBuffer(content: string): Promise<void> {
    const uri = this.getBufferUri();
    if (!uri) return;
    try {
      const dir = vscode.Uri.joinPath(uri, "..");
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    } catch (e) {
      // best-effort persist
    }
  }

  private getApexStorageDir(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    return path.join(root, ASFX_DIR);
  }

  private async loadApexState(): Promise<{ lastCode: string; history: string[] }> {
    let lastCode = "";
    const history: string[] = [];
    const dir = this.getApexStorageDir();
    if (dir) {
      try {
        const lastPath = path.join(dir, APEX_LAST_FILE);
        if (fs.existsSync(lastPath)) lastCode = fs.readFileSync(lastPath, "utf8");
      } catch {
        // ignore
      }
      try {
        const histPath = path.join(dir, APEX_HISTORY_FILE);
        if (fs.existsSync(histPath)) {
          const raw = fs.readFileSync(histPath, "utf8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) history.push(...parsed);
        }
      } catch {
        // ignore
      }
    }
    if (!lastCode.trim()) {
      lastCode = await this.readBuffer();
    }
    return { lastCode, history };
  }

  private async saveApexOnExecute(code: string): Promise<string[]> {
    const dir = this.getApexStorageDir();
    if (!dir) return [];
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const lastPath = path.join(dir, APEX_LAST_FILE);
      fs.writeFileSync(lastPath, code, "utf8");
      let history: string[] = [];
      const histPath = path.join(dir, APEX_HISTORY_FILE);
      if (fs.existsSync(histPath)) {
        try {
          const raw = fs.readFileSync(histPath, "utf8");
          history = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
        } catch {
          // ignore
        }
      }
      const trimmed = code.trim();
      if (trimmed) {
        history = [trimmed, ...history.filter((q) => q.trim() !== trimmed)].slice(0, APEX_HISTORY_MAX);
        fs.writeFileSync(histPath, JSON.stringify(history, null, 0), "utf8");
      }
      return history;
    } catch {
      return [];
    }
  }

  private _showErrorInPanel(webviewView: vscode.WebviewView, message: string): void {
    if (webviewView?.webview) {
      webviewView.webview.postMessage({ type: "showError", message });
    }
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    const { lastCode, history } = await this.loadApexState();
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, lastCode, history);

    if (this._messageListener) {
      this._messageListener.dispose();
    }
    this._messageListener = webviewView.webview.onDidReceiveMessage(
      async (data: { type: string; code?: string; targetOrg?: string }) => {
        if (data.type === "getOrgs") {
          const orgs = await getAnonymousApexOrgList();
          webviewView.webview.postMessage({ type: "orgList", orgs });
        } else if (data.type === "execute" && typeof data.code === "string") {
          if (!isSalesforceProject()) {
            this._showErrorInPanel(
              webviewView,
              "Open an SFDX project (folder containing sfdx-project.json) to use this feature."
            );
            return;
          }
          await this.writeBuffer(data.code);
          try {
            const result = await executeAnonymousApex(data.code, {
              fromPanel: true,
              targetOrg: data.targetOrg || undefined
            });
            if (result.success) {
              this._showErrorInPanel(webviewView, "");
              const newHistory = await this.saveApexOnExecute(data.code);
              webviewView.webview.postMessage({ type: "historyUpdated", history: newHistory });
            } else {
              this._showErrorInPanel(webviewView, result.errorMessage);
            }
          } catch (e: any) {
            const message = e?.message || e?.stderr || String(e);
            this._showErrorInPanel(webviewView, message);
          }
        } else if (data.type === "openInEditor") {
          const bufferUri = this.getBufferUri();
          if (bufferUri) {
            await this.writeBuffer(data.code || (await this.readBuffer()));
            try {
              const doc = await vscode.workspace.openTextDocument(bufferUri);
              await vscode.window.showTextDocument(doc, { preview: false });
            } catch {
              await vscode.commands.executeCommand("vscode.open", bufferUri);
            }
          }
        } else if (data.type === "contentChanged" && typeof data.code === "string") {
          await this.writeBuffer(data.code);
        }
      }
    );

    webviewView.onDidDispose(() => {
      if (this._messageListener) {
        this._messageListener.dispose();
        this._messageListener = undefined;
      }
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview, initialContent: string = "", history: string[] = []): string {
    const initialData = JSON.stringify({
      lastCode: initialContent || "",
      history: Array.isArray(history) ? history : []
    });
    const initialDataEscaped = initialData.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
	<title>Execute Apex</title>
	<style>
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 8px;
			font-family: var(--vscode-font-family, var(--vscode-editor-font-family, 'Segoe UI', sans-serif));
			font-size: var(--vscode-font-size, 13px);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			height: 100vh;
			display: flex;
			flex-direction: column;
		}
		.label {
			font-size: 11px;
			opacity: 0.9;
			margin-bottom: 4px;
		}
		.row {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 6px;
			flex-shrink: 0;
		}
		#org-select, #history-select {
			flex: 1;
			min-width: 0;
			padding: 4px 8px;
			font-size: 12px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 4px;
		}
		.editor-wrap {
			flex: 1;
			min-height: 120px;
			position: relative;
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 4px;
			overflow: hidden;
		}
		.editor-wrap:focus-within {
			outline: 1px solid var(--vscode-focusBorder);
		}
		#highlight-layer {
			position: absolute;
			top: 0; left: 0; right: 0; bottom: 0;
			padding: 8px;
			font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
			font-size: var(--vscode-editor-font-size, 13px);
			line-height: 1.5;
			white-space: pre-wrap;
			word-wrap: break-word;
			overflow: auto;
			pointer-events: none;
			color: transparent;
			background: var(--vscode-input-background);
		}
		#apex-editor {
			position: relative;
			width: 100%;
			height: 100%;
			padding: 8px;
			font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
			font-size: var(--vscode-editor-font-size, 13px);
			line-height: 1.5;
			resize: none;
			border: none;
			background: transparent;
			color: var(--vscode-input-foreground);
			caret-color: var(--vscode-editorCursor-foreground, var(--vscode-input-foreground));
			z-index: 1;
		}
		#apex-editor:focus { outline: none; }
		#apex-editor::placeholder { color: var(--vscode-input-placeholderForeground); }
		.hl-kw { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
		.hl-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
		.hl-str { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
		.hl-num { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
		.hl-cmt { color: var(--vscode-symbolIcon-enumeratorForeground, #6a9955); font-style: italic; }
		.hl-ann { color: var(--vscode-symbolIcon-interfaceForeground, #dcdcaa); }
		.hl-method { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa); }
		#error-box {
			margin-top: 8px;
			padding: 8px;
			font-size: 12px;
			line-height: 1.4;
			white-space: pre-wrap;
			word-break: break-word;
			background: var(--vscode-inputValidation-errorBackground);
			border: 1px solid var(--vscode-inputValidation-errorBorder);
			color: var(--vscode-errorForeground);
			border-radius: 4px;
			display: none;
			flex-shrink: 0;
			max-height: 120px;
			overflow: auto;
		}
		#error-box.visible { display: block; }
		.actions {
			display: flex;
			gap: 8px;
			margin-top: 8px;
			flex-shrink: 0;
			flex-wrap: wrap;
		}
		button {
			padding: 6px 14px;
			font-size: 13px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.shortcut-hint { font-size: 10px; opacity: 0.6; margin-left: 4px; }
	</style>
</head>
<body>
	<script type="application/json" id="apex-initial-data">${initialDataEscaped}</script>
	<div class="row">
		<span class="label" style="margin-bottom:0">History</span>
		<select id="history-select" title="Reopen a previous snippet">
			<option value="">History</option>
		</select>
	</div>
	<div class="row">
		<span class="label" style="margin-bottom:0">Target org</span>
		<select id="org-select" title="Org to execute against">
			<option value="">Loading...</option>
		</select>
	</div>
	<div class="label">Apex (anonymous execution)</div>
	<div class="editor-wrap">
		<div id="highlight-layer" aria-hidden="true"></div>
		<textarea id="apex-editor" placeholder="System.debug('Hello');&#10;Integer i = 1 + 1;" spellcheck="false"></textarea>
	</div>
	<div id="error-box" class="" role="alert"></div>
	<div class="actions">
		<button id="execute-btn" title="Execute (Ctrl+Enter)">Execute<span class="shortcut-hint">Ctrl+Enter</span></button>
		<button id="open-editor-btn" class="secondary" title="Open in VS Code editor for full Apex language support">Open in Editor</button>
		<button id="clear-btn" class="secondary">Clear</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const editor = document.getElementById('apex-editor');
		const highlightLayer = document.getElementById('highlight-layer');
		const errorBox = document.getElementById('error-box');
		const orgSelect = document.getElementById('org-select');
		const historySelect = document.getElementById('history-select');
		const initialEl = document.getElementById('apex-initial-data');

		const APEX_KEYWORDS = /\\b(abstract|after|before|break|catch|class|continue|delete|do|else|enum|extends|final|finally|for|get|global|if|implements|import|in|insert|instanceof|interface|merge|new|null|on|override|private|protected|public|return|set|static|super|switch|testmethod|this|throw|transient|trigger|try|undelete|update|upsert|virtual|void|webservice|when|while|with|without|sharing)\\b/g;
		const APEX_TYPES = /\\b(Boolean|Date|Datetime|Decimal|Double|Id|Integer|Long|Object|String|Blob|List|Map|Set|Account|Contact|Lead|Opportunity|Case|Task|System|Database|Test|Assert|UserInfo|Schema|Limits|ApexPages|Messaging)\\b/g;
		const APEX_ANNOTATIONS = /@\\w+/g;

		function escapeHtml(s) {
			return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
		}

		function highlightApex(code) {
			let html = '';
			let i = 0;
			while (i < code.length) {
				if (code[i] === '/' && code[i+1] === '/') {
					const end = code.indexOf('\\n', i);
					const slice = end === -1 ? code.slice(i) : code.slice(i, end);
					html += '<span class="hl-cmt">' + escapeHtml(slice) + '</span>';
					i += slice.length;
				} else if (code[i] === '/' && code[i+1] === '*') {
					const end = code.indexOf('*/', i + 2);
					const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
					html += '<span class="hl-cmt">' + escapeHtml(slice) + '</span>';
					i += slice.length;
				} else if (code[i] === "'" ) {
					let j = i + 1;
					while (j < code.length && code[j] !== "'" && code[j] !== '\\n') {
						if (code[j] === '\\\\') j++;
						j++;
					}
					if (j < code.length && code[j] === "'") j++;
					html += '<span class="hl-str">' + escapeHtml(code.slice(i, j)) + '</span>';
					i = j;
				} else if (code[i] === '@' && /[a-zA-Z]/.test(code[i+1] || '')) {
					const m = code.slice(i).match(/^@\\w+/);
					if (m) {
						html += '<span class="hl-ann">' + escapeHtml(m[0]) + '</span>';
						i += m[0].length;
					} else {
						html += escapeHtml(code[i]);
						i++;
					}
				} else if (/[a-zA-Z_]/.test(code[i])) {
					const m = code.slice(i).match(/^[a-zA-Z_]\\w*/);
					if (m) {
						const word = m[0];
						const nextChar = code[i + word.length];
						if (APEX_KEYWORDS.test(word)) {
							APEX_KEYWORDS.lastIndex = 0;
							html += '<span class="hl-kw">' + escapeHtml(word) + '</span>';
						} else if (APEX_TYPES.test(word)) {
							APEX_TYPES.lastIndex = 0;
							html += '<span class="hl-type">' + escapeHtml(word) + '</span>';
						} else if (nextChar === '(') {
							html += '<span class="hl-method">' + escapeHtml(word) + '</span>';
						} else {
							html += escapeHtml(word);
						}
						i += word.length;
					} else {
						html += escapeHtml(code[i]);
						i++;
					}
				} else if (/[0-9]/.test(code[i])) {
					const m = code.slice(i).match(/^[0-9]+(\\.[0-9]+)?/);
					if (m) {
						html += '<span class="hl-num">' + escapeHtml(m[0]) + '</span>';
						i += m[0].length;
					} else {
						html += escapeHtml(code[i]);
						i++;
					}
				} else {
					html += escapeHtml(code[i]);
					i++;
				}
			}
			return html + '\\n';
		}

		function syncHighlight() {
			highlightLayer.innerHTML = highlightApex(editor.value);
		}

		editor.addEventListener('scroll', () => {
			highlightLayer.scrollTop = editor.scrollTop;
			highlightLayer.scrollLeft = editor.scrollLeft;
		});
		editor.addEventListener('input', () => { syncHighlight(); });
		setTimeout(syncHighlight, 0);
		if (initialEl && initialEl.textContent) {
			try {
				const data = JSON.parse(initialEl.textContent);
				if (data.lastCode != null) editor.value = data.lastCode;
				(data.history || []).forEach((q, i) => {
					const opt = document.createElement('option');
					opt.value = String(i);
					opt.textContent = (q.length > 50 ? q.slice(0, 47) + '...' : q).replace(/\\s+/g, ' ');
					opt.title = q;
					historySelect.appendChild(opt);
				});
			} catch (e) {}
		}
		function setHistoryDropdown(items) {
			while (historySelect.options.length > 1) historySelect.remove(1);
			(items || []).forEach((q, i) => {
				const opt = document.createElement('option');
				opt.value = String(i);
				opt.textContent = (q.length > 50 ? q.slice(0, 47) + '...' : q).replace(/\\s+/g, ' ');
				opt.title = q;
				historySelect.appendChild(opt);
			});
		}
		historySelect.addEventListener('change', () => {
			if (historySelect.value === '') return;
			const opt = historySelect.options[historySelect.selectedIndex];
			const code = opt ? opt.title : '';
			if (code) { editor.value = code; editor.focus(); syncHighlight(); }
			historySelect.selectedIndex = 0;
		});
		vscode.postMessage({ type: 'getOrgs' });
		window.addEventListener('message', (e) => {
			if (!e.data) return;
			if (e.data.type === 'showError') showError(e.data.message || '');
			if (e.data.type === 'orgList') {
				const orgs = e.data.orgs || [];
				orgSelect.innerHTML = orgs.length ? orgs.map(o => '<option value="' + (o.username || '').replace(/"/g, '&quot;') + '">' + (o.label || o.username || '').replace(/</g, '&lt;') + '</option>').join('') : '<option value="">No orgs</option>';
			}
			if (e.data.type === 'historyUpdated') setHistoryDropdown(e.data.history || []);
		});
		let saveTimeout = null;
		function scheduleSave() {
			if (saveTimeout) clearTimeout(saveTimeout);
			saveTimeout = setTimeout(() => {
				vscode.postMessage({ type: 'contentChanged', code: editor.value });
				saveTimeout = null;
			}, 500);
		}
		function showError(msg) {
			errorBox.textContent = msg || '';
			errorBox.classList.toggle('visible', !!msg);
		}
		editor.addEventListener('input', () => { scheduleSave(); syncHighlight(); });

		function doExecute() {
			showError('');
			const targetOrg = (orgSelect.value || '').trim();
			vscode.postMessage({ type: 'execute', code: editor.value, targetOrg: targetOrg || undefined });
		}

		document.getElementById('execute-btn').onclick = doExecute;

		editor.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				e.preventDefault();
				doExecute();
			}
			if (e.key === 'Tab') {
				e.preventDefault();
				const start = editor.selectionStart;
				const end = editor.selectionEnd;
				editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
				editor.selectionStart = editor.selectionEnd = start + 4;
				syncHighlight();
				scheduleSave();
			}
		});

		document.getElementById('open-editor-btn').onclick = () => {
			vscode.postMessage({ type: 'openInEditor' });
		};

		document.getElementById('clear-btn').onclick = () => {
			editor.value = '';
			editor.focus();
			showError('');
			syncHighlight();
			vscode.postMessage({ type: 'contentChanged', code: '' });
		};
	</script>
</body>
</html>`;
  }
}
