import * as vscode from "vscode";
import { runCommand, runCommandArgs } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";

export class SOQLEditorProvider {
	public static readonly viewType = "adure-sfx-toolkit.soqlEditor";

	public static show(extensionUri: vscode.Uri) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		const panel = vscode.window.createWebviewPanel(
			SOQLEditorProvider.viewType,
			"SOQL Editor",
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, "resources")],
			}
		);

		panel.webview.html = this._getHtmlForWebview(panel.webview, extensionUri);

		panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case "execute":
						await this.executeQuery(panel, message.query);
						break;
					case "save":
						await this.saveChanges(panel, message.changes);
						break;
					case "error":
						vscode.window.showErrorMessage(message.text);
						break;
				}
			},
			null,
			[]
		);
	}

	private static async executeQuery(panel: vscode.WebviewPanel, query: string) {
		try {
			// Send loading state
			panel.webview.postMessage({ command: "loading", value: true });

			const resultStr = await runCommand(`sf data query --query "${query}" --json`);
			const result = JSON.parse(resultStr);

			if (result.status === 0) {
				panel.webview.postMessage({
					command: "results",
					data: result.result.records,
					totalSize: result.result.totalSize,
					done: result.result.done,
				});
			} else {
				panel.webview.postMessage({ command: "error", text: result.message || "Unknown Error" });
			}
		} catch (e: any) {
			const errorMsg = e.stderr || e.message || JSON.stringify(e);
			panel.webview.postMessage({ command: "error", text: errorMsg });
		} finally {
			panel.webview.postMessage({ command: "loading", value: false });
		}
	}

	private static async saveChanges(panel: vscode.WebviewPanel, changes: any) {
		// changes: { [id]: { [field]: value, attributes: { type: 'Account' } } }
		// We need SObject type. The frontend should pass it or we infer it.
		// Assuming frontend passes it or we extract from query results previously?
		// Let's expect the frontend to pass the SObject type for each row or we use a heuristic.
		// Actually, 'attributes.type' is standard in query results. The frontend should preserve it.

		try {
			panel.webview.postMessage({ command: "saving", value: true });

			let successCount = 0;
			let errors: string[] = [];

			for (const id of Object.keys(changes)) {
				const recordChanges = changes[id];
				const type = recordChanges._type; // SObject Type
				delete recordChanges._type;

				if (!type) {
					errors.push(`Missing object type for ID ${id}`);
					continue;
				}

				for (const field of Object.keys(recordChanges)) {
					const value = recordChanges[field];

					try {
						// Use runCommandArgs for safe argument passing (avoids shell escaping issues)
						const resultStr = await runCommandArgs("sf", [
							"data",
							"update",
							"record",
							"--sobject",
							type,
							"--record-id",
							id,
							"--values",
							`${field}=${value}`,
							"--json",
						]);

						const result = JSON.parse(resultStr);
						if (result.status !== 0) {
							throw new Error(result.message || "Unknown SF Error");
						}
						successCount++;
					} catch (e: any) {
						let errMsg = e.message;
						// Try to parse JSON output from stdout if available (SF CLI often puts error json in stdout)
						if (e.stdout) {
							try {
								const output = JSON.parse(e.stdout);
								if (output.message) {
									errMsg = output.message;
								} else if (Array.isArray(output) && output[0] && output[0].message) {
									errMsg = output[0].message;
								}
							} catch (jsonErr) {
								// ignore
							}
						}
						errors.push(`Failed to update ${id}.${field}: ${errMsg}`);
					}
				}
			}

			if (errors.length > 0) {
				vscode.window.showErrorMessage(`Saved ${successCount} changes. Errors: ${errors.join("; ")}`);
			} else {
				vscode.window.showInformationMessage(`Successfully saved ${successCount} changes.`);
			}

			// Refresh results? Or let user do it?
			// Let's tell frontend to clear dirty state
			panel.webview.postMessage({ command: "saveComplete", success: errors.length === 0 });
		} catch (e: any) {
			vscode.window.showErrorMessage(`Save failed: ${e.message}`);
			panel.webview.postMessage({ command: "saveComplete", success: false });
		} finally {
			panel.webview.postMessage({ command: "saving", value: false });
		}
	}

	private static _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SOQL Editor</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        .controls { display: flex; gap: 10px; margin-bottom: 20px; align-items: flex-start; }
        textarea { flex-grow: 1; height: 80px; font-family: monospace; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: 0.5; cursor: default; }
        #results-container { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
        th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); }
        th { background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 0; }
        td[contenteditable="true"]:focus { outline: 2px solid var(--vscode-focusBorder); background: var(--vscode-input-background); }
        .changed { background-color: rgba(255, 255, 0, 0.2); }
        .status-bar { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; }
        .error { color: var(--vscode-errorForeground); margin-top: 10px; }
    </style>
</head>
<body>
    <div class="controls">
        <textarea id="query-input" placeholder="SELECT Id, Name FROM Account LIMIT 10">SELECT Id, Name FROM Account LIMIT 10</textarea>
        <div style="display: flex; flex-direction: column; gap: 5px;">
            <button id="execute-btn">Execute</button>
            <div style="display: flex; gap: 5px;">
                <button id="save-btn" style="display: none; background-color: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground);">Save</button>
                <button id="discard-btn" style="display: none;">Discard</button>
            </div>
        </div>
    </div>
    
    <div id="error-msg" class="error"></div>
    <div id="results-container"></div>
    <div class="status-bar" id="status-bar"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const queryInput = document.getElementById('query-input');
        const executeBtn = document.getElementById('execute-btn');
        const saveBtn = document.getElementById('save-btn');
        const discardBtn = document.getElementById('discard-btn');
        const resultsContainer = document.getElementById('results-container');
        const errorMsg = document.getElementById('error-msg');
        const statusBar = document.getElementById('status-bar');

        let currentRecords = [];
        let changes = {}; // { rowId: { field: value, _type: SObjectType } }

        executeBtn.addEventListener('click', () => {
            const query = queryInput.value;
            if (!query) return;
            changes = {};
            updateSaveButton();
            vscode.postMessage({ command: 'execute', query });
        });

        saveBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'save', changes });
        });

        discardBtn.addEventListener('click', () => {
            // Re-render original results
            changes = {};
            updateSaveButton();
            if (currentRecords) {
                renderTable(currentRecords);
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'loading':
                    executeBtn.disabled = message.value;
                    executeBtn.textContent = message.value ? 'Running...' : 'Execute';
                    if (message.value) {
                        errorMsg.textContent = '';
                        // Don't clear results immediately to prevent flash? Maybe clear.
                        // resultsContainer.innerHTML = ''; 
                    }
                    break;
                case 'saving':
                    saveBtn.disabled = message.value;
                    discardBtn.disabled = message.value;
                    saveBtn.textContent = message.value ? 'Saving...' : 'Save';
                    break;
                case 'results':
                    renderTable(message.data);
                    statusBar.textContent = \`Total: \${message.totalSize} records\`;
                    break;
                case 'error':
                    errorMsg.textContent = message.text;
                    resultsContainer.innerHTML = '';
                    statusBar.textContent = '';
                    break;
                case 'saveComplete':
                    if (message.success) {
                        changes = {};
                        updateSaveButton();
                        // Ideally re-run query, but for now just clear dirty styles
                        document.querySelectorAll('.changed').forEach(el => el.classList.remove('changed'));
                    }
                    break;
            }
        });

        function renderTable(records) {
            currentRecords = records;
            resultsContainer.innerHTML = '';
            if (!records || records.length === 0) {
                resultsContainer.textContent = 'No records found.';
                return;
            }

            // Extract headers
            // We want all keys except 'attributes'
            // But records might have different keys if they are child relationships? 
            // Standard SOQL at top level: consistent keys usually.
            
            const columns = new Set();
            records.forEach(r => {
                Object.keys(r).forEach(k => {
                    if (k !== 'attributes') columns.add(k);
                });
            });
            const headers = Array.from(columns);

            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const trHead = document.createElement('tr');
            headers.forEach(h => {
                const th = document.createElement('th');
                th.textContent = h;
                trHead.appendChild(th);
            });
            thead.appendChild(trHead);
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            records.forEach(r => {
                const tr = document.createElement('tr');
                const recId = r.Id; // Might be undefined if not selected
                const type = r.attributes ? r.attributes.type : null;

                headers.forEach(h => {
                    const td = document.createElement('td');
                    const value = r[h];
                    
                    if (typeof value === 'object' && value !== null) {
                        td.textContent = JSON.stringify(value); // Child records or objects
                    } else {
                        td.textContent = value === null ? '' : value;
                    }

                    // Editable if it has an ID and we know the type, and it's not a nested object
                    if (recId && type && h !== 'Id' && typeof value !== 'object') {
                        td.contentEditable = true;
                        td.addEventListener('input', (e) => {
                            const newValue = td.textContent;
                            if (!changes[recId]) changes[recId] = { _type: type };
                            changes[recId][h] = newValue;
                            td.classList.add('changed');
                            updateSaveButton();
                        });
                    }
                    
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            resultsContainer.appendChild(table);
        }

        function updateSaveButton() {
            const hasChanges = Object.keys(changes).length > 0;
            saveBtn.style.display = hasChanges ? 'block' : 'none';
            discardBtn.style.display = hasChanges ? 'block' : 'none';
        }
    </script>
</body>
</html>`;
	}
}
