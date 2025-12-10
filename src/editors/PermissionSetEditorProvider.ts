import * as vscode from 'vscode';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

export class PermissionSetEditorProvider implements vscode.CustomTextEditorProvider {

    public static readonly viewType = 'salesforce-utils.permissionSetEditor';

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new PermissionSetEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(PermissionSetEditorProvider.viewType, provider);
        return providerRegistration;
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        function updateWebview() {
            const parser = new XMLParser({
                ignoreAttributes: false,
                parseAttributeValue: true,
                isArray: (name, jpath, isLeafNode, isAttribute) => { 
                    return [
                        'classAccesses', 'fieldPermissions', 'objectPermissions', 'pageAccesses', 
                        'recordTypeVisibilities', 'tabSettings', 'userPermissions', 'applicationVisibilities'
                    ].indexOf(name) !== -1;
                }
            });
            
            try {
                const text = document.getText();
                if (!text.trim()) {
                    webviewPanel.webview.postMessage({ type: 'update', data: {} });
                    return;
                }
                const jsonObj = parser.parse(text);
                webviewPanel.webview.postMessage({
                    type: 'update',
                    data: jsonObj.PermissionSet || {}
                });
            } catch (e) {
                console.error("Error parsing XML", e);
            }
        }

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                updateWebview();
            }
        });

        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });

        webviewPanel.webview.onDidReceiveMessage(e => {
            switch (e.type) {
                case 'update':
                    this.updateDocument(document, e.data);
                    return;
            }
        });

        updateWebview();
    }

    private updateDocument(document: vscode.TextDocument, permissionSetData: any) {
        const builder = new XMLBuilder({
            ignoreAttributes: false,
            format: true,
            indentBy: '    '
        });
        
        const obj = {
            PermissionSet: {
                ...permissionSetData,
                '@_xmlns': 'http://soap.sforce.com/2006/04/metadata'
            }
        };

        const xmlContent = builder.build(obj);

        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            xmlContent
        );

        vscode.workspace.applyEdit(edit);
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                    .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 10px; }
                    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; opacity: 0.7; }
                    .tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
                    .tab.active { border-bottom: 2px solid var(--vscode-activityBar-activeBorder); opacity: 1; font-weight: bold; }
                    .content { display: none; }
                    .content.active { display: block; }
                    input[type="text"] { width: 100%; padding: 8px; margin-bottom: 10px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
                    th { font-weight: bold; opacity: 0.8; }
                    tr:hover { background-color: var(--vscode-list-hoverBackground); }
                    input[type="checkbox"] { cursor: pointer; }
                </style>
            </head>
            <body>
                <div class="tabs">
                    <div class="tab active" onclick="openTab('objects')">Object Permissions</div>
                    <div class="tab" onclick="openTab('fields')">Field Permissions</div>
                    <div class="tab" onclick="openTab('classes')">Apex Classes</div>
                </div>

                <div id="objects" class="content active">
                    <input type="text" id="objSearch" placeholder="Search Objects..." onkeyup="filterTable('objTable', 0)">
                    <table id="objTable">
                        <thead>
                            <tr>
                                <th>Object</th>
                                <th>Read</th>
                                <th>Create</th>
                                <th>Edit</th>
                                <th>Delete</th>
                                <th>View All</th>
                                <th>Modify All</th>
                            </tr>
                        </thead>
                        <tbody id="objBody"></tbody>
                    </table>
                </div>

                <div id="fields" class="content">
                    <input type="text" id="fieldSearch" placeholder="Search Fields..." onkeyup="filterTable('fieldTable', 0)">
                    <table id="fieldTable">
                        <thead>
                            <tr>
                                <th>Field</th>
                                <th>Object</th>
                                <th>Read</th>
                                <th>Edit</th>
                            </tr>
                        </thead>
                        <tbody id="fieldBody"></tbody>
                    </table>
                </div>

                <div id="classes" class="content">
                    <input type="text" id="classSearch" placeholder="Search Classes..." onkeyup="filterTable('classTable', 0)">
                    <table id="classTable">
                        <thead>
                            <tr>
                                <th>Apex Class</th>
                                <th>Enabled</th>
                            </tr>
                        </thead>
                        <tbody id="classBody"></tbody>
                    </table>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let currentData = {};

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'update') {
                            currentData = message.data;
                            render();
                        }
                    });

                    function render() {
                        renderObjects(currentData.objectPermissions || []);
                        renderFields(currentData.fieldPermissions || []);
                        renderClasses(currentData.classAccesses || []);
                    }

                    function openTab(tabName) {
                        document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
                        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                        document.getElementById(tabName).classList.add('active');
                        event.target.classList.add('active');
                    }

                    function filterTable(tableId, colIndex) {
                        const input = event.target;
                        const filter = input.value.toUpperCase();
                        const table = document.getElementById(tableId);
                        const tr = table.getElementsByTagName("tr");
                        for (let i = 1; i < tr.length; i++) {
                            const td = tr[i].getElementsByTagName("td")[colIndex];
                            if (td) {
                                const txtValue = td.textContent || td.innerText;
                                tr[i].style.display = txtValue.toUpperCase().indexOf(filter) > -1 ? "" : "none";
                            }
                        }
                    }

                    function updateState() {
                        vscode.postMessage({
                            type: 'update',
                            data: currentData
                        });
                    }

                    // --- RENDERERS ---

                    function renderObjects(perms) {
                        const tbody = document.getElementById('objBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${p.object}</td>
                                <td><input type="checkbox" \${p.allowRead === true || p.allowRead === 'true' ? 'checked' : ''} onchange="updateObjPerm(\${index}, 'allowRead', this.checked)"></td>
                                <td><input type="checkbox" \${p.allowCreate === true || p.allowCreate === 'true' ? 'checked' : ''} onchange="updateObjPerm(\${index}, 'allowCreate', this.checked)"></td>
                                <td><input type="checkbox" \${p.allowEdit === true || p.allowEdit === 'true' ? 'checked' : ''} onchange="updateObjPerm(\${index}, 'allowEdit', this.checked)"></td>
                                <td><input type="checkbox" \${p.allowDelete === true || p.allowDelete === 'true' ? 'checked' : ''} onchange="updateObjPerm(\${index}, 'allowDelete', this.checked)"></td>
                                <td><input type="checkbox" \${p.viewAllRecords === true || p.viewAllRecords === 'true' ? 'checked' : ''} onchange="updateObjPerm(\${index}, 'viewAllRecords', this.checked)"></td>
                                <td><input type="checkbox" \${p.modifyAllRecords === true || p.modifyAllRecords === 'true' ? 'checked' : ''} onchange="updateObjPerm(\${index}, 'modifyAllRecords', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateObjPerm(index, field, value) {
                        currentData.objectPermissions[index][field] = value;
                        updateState();
                    }

                    function renderFields(perms) {
                        const tbody = document.getElementById('fieldBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const parts = p.field.split('.');
                            const objName = parts.length > 1 ? parts[0] : '';
                            const fieldName = parts.length > 1 ? parts[1] : p.field;

                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${fieldName}</td>
                                <td>\${objName}</td>
                                <td><input type="checkbox" \${p.readable === true || p.readable === 'true' ? 'checked' : ''} onchange="updateFieldPerm(\${index}, 'readable', this.checked)"></td>
                                <td><input type="checkbox" \${p.editable === true || p.editable === 'true' ? 'checked' : ''} onchange="updateFieldPerm(\${index}, 'editable', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateFieldPerm(index, field, value) {
                        currentData.fieldPermissions[index][field] = value;
                        updateState();
                    }

                    function renderClasses(perms) {
                        const tbody = document.getElementById('classBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${p.apexClass}</td>
                                <td><input type="checkbox" \${p.enabled === true || p.enabled === 'true' ? 'checked' : ''} onchange="updateClassPerm(\${index}, 'enabled', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateClassPerm(index, field, value) {
                        currentData.classAccesses[index][field] = value;
                        updateState();
                    }
                </script>
            </body>
            </html>
        `;
    }
}
