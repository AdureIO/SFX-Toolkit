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
                        'recordTypeVisibilities', 'tabSettings', 'userPermissions', 'applicationVisibilities',
                        'customPermissions', 'customMetadataTypeAccesses', 'flowAccesses',
                        'externalDataSourceAccesses', 'customSettingAccesses'
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
                case 'fetchObjects':
                    this.fetchObjects(webviewPanel.webview);
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

    private async fetchObjects(webview: vscode.Webview) {
        try {
            const { runCommand } = require('../utils/commandRunner');
            
            console.log('Starting to fetch objects and fields...');
            
            // First, check if we have a default org
            let orgResult;
            try {
                orgResult = await runCommand('sf org display --json');
            } catch (e) {
                throw new Error('No default org set. Please run "sf org login" or set a default org.');
            }
            
            const orgParsed = JSON.parse(orgResult);
            if (orgParsed.status !== 0) {
                throw new Error('No default org set. Please set a default org first.');
            }
            
            const orgAlias = orgParsed.result?.alias || orgParsed.result?.username;
            console.log('Using org:', orgAlias);
            
            // Single query to get all objects and their fields using EntityParticle
            const query = `SELECT EntityDefinition.QualifiedApiName, EntityDefinition.Label, QualifiedApiName, Label, DataType 
                          FROM EntityParticle 
                          WHERE EntityDefinition.IsCustomizable = true 
                          ORDER BY EntityDefinition.QualifiedApiName, QualifiedApiName`;
            
            console.log('Executing Tooling API query...');
            const result = await runCommand(`sf data query --query "${query}" --use-tooling-api --json`);
            console.log('Query completed, parsing results...');
            
            const parsed = JSON.parse(result);
            
            if (parsed.status !== 0) {
                console.error('Query failed:', parsed.message);
                throw new Error(parsed.message || 'Query failed');
            }
            
            if (!parsed.result || !parsed.result.records) {
                console.error('No records in result');
                throw new Error('No records returned from query');
            }
            
            console.log('Received ' + parsed.result.records.length + ' field records');
            
            // Group fields by object
            const objectsMap = new Map<string, any>();
            
            for (const record of parsed.result.records) {
                const objectName = record.EntityDefinition.QualifiedApiName;
                const objectLabel = record.EntityDefinition.Label;
                
                if (!objectsMap.has(objectName)) {
                    objectsMap.set(objectName, {
                        name: objectName,
                        label: objectLabel || objectName,
                        fields: []
                    });
                }
                
                objectsMap.get(objectName)!.fields.push({
                    name: record.QualifiedApiName,
                    label: record.Label || record.QualifiedApiName,
                    dataType: record.DataType
                });
            }
            
            const objectsWithFields = Array.from(objectsMap.values());
            console.log('Prepared ' + objectsWithFields.length + ' objects with fields');

            webview.postMessage({
                type: 'objectsTree',
                data: objectsWithFields
            });
        } catch (error: any) {
            console.error('Failed to fetch objects:', error);
            
            webview.postMessage({
                type: 'objectsTree',
                data: [],
                error: error.message || 'Failed to load objects and fields'
            });
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                    .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 10px; flex-wrap: wrap; }
                    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; opacity: 0.7; }
                    .tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
                    .tab.active { border-bottom: 2px solid var(--vscode-activityBar-activeBorder); opacity: 1; font-weight: bold; }
                    .content { display: none; }
                    .content.active { display: block; }
                    input[type="text"], textarea { width: 100%; padding: 8px; margin-bottom: 10px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); box-sizing: border-box; }
                    textarea { font-family: 'Courier New', monospace; font-size: 12px; }
                    select { padding: 6px; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); }
                    input[type="checkbox"] { cursor: pointer; }
                    
                    /* Tree View Styles */
                    .tree { margin-top: 10px; }
                    .tree-object { margin-bottom: 4px; }
                    .tree-object-header { padding: 4px; cursor: pointer; display: flex; align-items: center; }
                    .tree-object-header:hover { background: var(--vscode-list-hoverBackground); }
                    .tree-expand { margin-right: 4px; font-family: monospace; width: 16px; display: inline-block; }
                    .tree-object-fields { display: none; margin-left: 24px; }
                    .tree-object-fields.expanded { display: block; }
                    .tree-field { padding: 4px; display: flex; align-items: center; }
                    .tree-field:hover { background: var(--vscode-list-hoverBackground); }
                    .loading { padding: 20px; text-align: center; opacity: 0.7; }
                    
                    /* Table styles for other tabs */
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
                    th { font-weight: bold; opacity: 0.8; }
                    tr:hover { background-color: var(--vscode-list-hoverBackground); }
                </style>
            </head>
            <body>
                <div class="tabs">
                    <div class="tab active" onclick="openTab('objectsFields')">Objects & Fields</div>
                    <div class="tab" onclick="openTab('classes')">Apex Classes</div>
                    <div class="tab" onclick="openTab('user')">User Permissions</div>
                    <div class="tab" onclick="openTab('pages')">Visualforce Pages</div>
                    <div class="tab" onclick="openTab('tabs')">Tabs</div>
                    <div class="tab" onclick="openTab('apps')">Applications</div>
                    <div class="tab" onclick="openTab('recordTypes')">Record Types</div>
                    <div class="tab" onclick="openTab('customPerms')">Custom Permissions</div>
                    <div class="tab" onclick="openTab('xml')">XML</div>
                </div>

                <!-- Objects & Fields Tree -->
                <div id="objectsFields" class="content active">
                    <input type="text" id="objFieldSearch" placeholder="Search objects and fields..." onkeyup="filterTree()">
                    <div id="objectsTree" class="tree">
                        <div class="loading">Loading objects and fields from org...</div>
                    </div>
                </div>

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

                <!-- Apex Classes -->
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

                <!-- Apex Classes -->
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

                <!-- User Permissions -->
                <div id="user" class="content">
                    <input type="text" id="userSearch" placeholder="Search User Permissions..." onkeyup="filterTable('userTable', 0)">
                    <table id="userTable">
                        <thead>
                            <tr>
                                <th>Permission</th>
                                <th>Enabled</th>
                            </tr>
                        </thead>
                        <tbody id="userBody"></tbody>
                    </table>
                </div>

                <!-- Visualforce Pages -->
                <div id="pages" class="content">
                    <input type="text" id="pageSearch" placeholder="Search Pages..." onkeyup="filterTable('pageTable', 0)">
                    <table id="pageTable">
                        <thead>
                            <tr>
                                <th>Visualforce Page</th>
                                <th>Enabled</th>
                            </tr>
                        </thead>
                        <tbody id="pageBody"></tbody>
                    </table>
                </div>

                <!-- Tab Settings -->
                <div id="tabs" class="content">
                    <input type="text" id="tabSearch" placeholder="Search Tabs..." onkeyup="filterTable('tabTable', 0)">
                    <table id="tabTable">
                        <thead>
                            <tr>
                                <th>Tab</th>
                                <th>Visibility</th>
                            </tr>
                        </thead>
                        <tbody id="tabBody"></tbody>
                    </table>
                </div>

                <!-- Applications -->
                <div id="apps" class="content">
                    <input type="text" id="appSearch" placeholder="Search Applications..." onkeyup="filterTable('appTable', 0)">
                    <table id="appTable">
                        <thead>
                            <tr>
                                <th>Application</th>
                                <th>Visible</th>
                                <th>Default</th>
                            </tr>
                        </thead>
                        <tbody id="appBody"></tbody>
                    </table>
                </div>

                <!-- Record Types -->
                <div id="recordTypes" class="content">
                    <input type="text" id="rtSearch" placeholder="Search Record Types..." onkeyup="filterTable('rtTable', 0)">
                    <table id="rtTable">
                        <thead>
                            <tr>
                                <th>Record Type</th>
                                <th>Object</th>
                                <th>Visible</th>
                                <th>Default</th>
                            </tr>
                        </thead>
                        <tbody id="rtBody"></tbody>
                    </table>
                </div>

                <!-- Custom Permissions -->
                <div id="customPerms" class="content">
                    <input type="text" id="cpSearch" placeholder="Search Custom Permissions..." onkeyup="filterTable('cpTable', 0)">
                    <table id="cpTable">
                        <thead>
                            <tr>
                                <th>Custom Permission</th>
                                <th>Enabled</th>
                            </tr>
                        </thead>
                        <tbody id="cpBody"></tbody>
                    </table>
                </div>

                <!-- XML Tab -->
                <div id="xml" class="content">
                    <textarea id="xmlEditor" rows="25"></textarea>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let currentData = {};
                    let isUpdatingUI = false;
                    let allObjectsTree = [];

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'update') {
                            currentData = message.data;
                            render();
                        } else if (message.type === 'objectsTree') {
                            allObjectsTree = message.data;
                            if (message.error) {
                                const container = document.getElementById('objectsTree');
                                container.innerHTML = '<div class="loading" style="color: var(--vscode-errorForeground);">Error loading objects: ' + message.error + '</div>';
                            } else {
                                renderObjectsTree();
                            }
                        }
                    });

                    // Fetch objects from org on load
                    vscode.postMessage({ type: 'fetchObjects' });

                    function renderObjectsTree() {
                        const container = document.getElementById('objectsTree');
                        if (allObjectsTree.length === 0) {
                            container.innerHTML = '<div class="loading">No objects found or still loading...</div>';
                            return;
                        }

                        container.innerHTML = '';
                        
                        allObjectsTree.forEach(obj => {
                            const objectDiv = document.createElement('div');
                            objectDiv.className = 'tree-object';
                            
                            // Object header with expand/collapse
                            const header = document.createElement('div');
                            header.className = 'tree-object-header';
                            header.innerHTML = '<span class="tree-expand" data-object="' + obj.name + '">▶</span>' +
                                '<input type="checkbox" id="obj_' + obj.name + '" onchange="toggleObjectPermissions(\'' + obj.name + '\', this.checked)">' +
                                '<label for="obj_' + obj.name + '" style="margin-left: 8px; cursor: pointer;">' + obj.name + ' (' + obj.label + ')</label>';
                            
                            header.querySelector('.tree-expand').addEventListener('click', (e) => {
                                e.stopPropagation();
                                toggleObjectExpand(obj.name);
                            });
                            
                            // Fields container (initially collapsed)
                            const fieldsDiv = document.createElement('div');
                            fieldsDiv.className = 'tree-object-fields';
                            fieldsDiv.id = 'fields_' + obj.name;
                            
                            obj.fields.forEach(field => {
                                const fieldDiv = document.createElement('div');
                                fieldDiv.className = 'tree-field';
                                fieldDiv.innerHTML = '<input type="checkbox" id="field_' + obj.name + '_' + field.name + '" onchange="toggleFieldPermission(\'' + obj.name + '\', \'' + field.name + '\', this.checked)">' +
                                    '<label for="field_' + obj.name + '_' + field.name + '" style="margin-left: 8px; cursor: pointer;">' + field.name + ' (' + field.label + ') - ' + field.dataType + '</label>';
                                fieldsDiv.appendChild(fieldDiv);
                            });
                            
                            objectDiv.appendChild(header);
                            objectDiv.appendChild(fieldsDiv);
                            container.appendChild(objectDiv);
                        });
                        
                        // Check existing permissions
                        syncTreeWithCurrentData();
                    }

                    function toggleObjectExpand(objectName) {
                        const fieldsDiv = document.getElementById('fields_' + objectName);
                        const expandIcon = document.querySelector('[data-object="' + objectName + '"]');
                        
                        if (fieldsDiv.classList.contains('expanded')) {
                            fieldsDiv.classList.remove('expanded');
                            expandIcon.textContent = '▶';
                        } else {
                            fieldsDiv.classList.add('expanded');
                            expandIcon.textContent = '▼';
                        }
                    }

                    function syncTreeWithCurrentData() {
                        // Check object permissions
                        if (currentData.objectPermissions) {
                            currentData.objectPermissions.forEach(perm => {
                                const checkbox = document.getElementById('obj_' + perm.object);
                                if (checkbox) checkbox.checked = true;
                            });
                        }
                        
                        // Check field permissions
                        if (currentData.fieldPermissions) {
                            currentData.fieldPermissions.forEach(perm => {
                                const parts = perm.field.split('.');
                                if (parts.length === 2) {
                                    const checkbox = document.getElementById('field_' + parts[0] + '_' + parts[1]);
                                    if (checkbox) checkbox.checked = true;
                                }
                            });
                        }
                    }

                    function toggleObjectPermissions(objectName, checked) {
                        if (!currentData.objectPermissions) currentData.objectPermissions = [];
                        
                        if (checked) {
                            // Add if doesn't exist
                            const exists = currentData.objectPermissions.some(p => p.object === objectName);
                            if (!exists) {
                                currentData.objectPermissions.push({
                                    object: objectName,
                                    allowRead: true,
                                    allowCreate: false,
                                    allowEdit: false,
                                    allowDelete: false,
                                    viewAllRecords: false,
                                    modifyAllRecords: false
                                });
                            }
                        } else {
                            // Remove
                            currentData.objectPermissions = currentData.objectPermissions.filter(p => p.object !== objectName);
                        }
                        
                        updateState();
                    }

                    function toggleFieldPermission(objectName, fieldName, checked) {
                        if (!currentData.fieldPermissions) currentData.fieldPermissions = [];
                        
                        const fullFieldName = objectName + '.' + fieldName;
                        
                        if (checked) {
                            // Add if doesn't exist
                            const exists = currentData.fieldPermissions.some(p => p.field === fullFieldName);
                            if (!exists) {
                                currentData.fieldPermissions.push({
                                    field: fullFieldName,
                                    readable: true,
                                    editable: false
                                });
                            }
                        } else {
                            // Remove
                            currentData.fieldPermissions = currentData.fieldPermissions.filter(p => p.field !== fullFieldName);
                        }
                        
                        updateState();
                    }

                    function filterTree() {
                        const searchInput = document.getElementById('objFieldSearch');
                        const filter = searchInput.value.toUpperCase();
                        const treeObjects = document.querySelectorAll('.tree-object');
                        
                        treeObjects.forEach(objDiv => {
                            const objLabel = objDiv.querySelector('.tree-object-header label').textContent;
                            const fields = objDiv.querySelectorAll('.tree-field label');
                            
                            let showObject = objLabel.toUpperCase().indexOf(filter) > -1;
                            let visibleFieldsCount = 0;
                            
                            fields.forEach(fieldLabel => {
                                const fieldText = fieldLabel.textContent;
                                if (fieldText.toUpperCase().indexOf(filter) > -1) {
                                    fieldLabel.parentElement.style.display = '';
                                    visibleFieldsCount++;
                                    showObject = true;
                                } else {
                                    fieldLabel.parentElement.style.display = 'none';
                                }
                            });
                            
                            objDiv.style.display = showObject ? '' : 'none';
                        });
                    }

                    function render() {
                        isUpdatingUI = true;
                        renderObjects(currentData.objectPermissions || []);
                        renderFields(currentData.fieldPermissions || []);
                        renderClasses(currentData.classAccesses || []);
                        renderUserPermissions(currentData.userPermissions || []);
                        renderPages(currentData.pageAccesses || []);
                        renderTabs(currentData.tabSettings || []);
                        renderApps(currentData.applicationVisibilities || []);
                        renderRecordTypes(currentData.recordTypeVisibilities || []);
                        renderCustomPermissions(currentData.customPermissions || []);
                        updateXmlEditor();
                        isUpdatingUI = false;
                    }

                    function openTab(tabName) {
                        if (tabName === 'xml') {
                            updateXmlEditor();
                        } else if (document.querySelector('.tab[onclick*="xml"]').parentElement.querySelector('.tab.active')?.textContent === 'XML') {
                            parseXmlEditor();
                        }
                        
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
                        if (!isUpdatingUI) {
                            vscode.postMessage({
                                type: 'update',
                                data: currentData
                            });
                        }
                    }

                    function updateXmlEditor() {
                        const xmlEditor = document.getElementById('xmlEditor');
                        // Convert JSON to XML-like display (simple indented JSON for now)
                        xmlEditor.value = JSON.stringify(currentData, null, 4);
                    }

                    function parseXmlEditor() {
                        const xmlEditor = document.getElementById('xmlEditor');
                        try {
                            const parsed = JSON.parse(xmlEditor.value);
                            currentData = parsed;
                            vscode.postMessage({ type: 'update', data: parsed });
                            isUpdatingUI = true;
                            renderObjects(currentData.objectPermissions || []);
                            renderFields(currentData.fieldPermissions || []);
                            renderClasses(currentData.classAccesses || []);
                            renderUserPermissions(currentData.userPermissions || []);
                            renderPages(currentData.pageAccesses || []);
                            renderTabs(currentData.tabSettings || []);
                            renderApps(currentData.applicationVisibilities || []);
                            renderRecordTypes(currentData.recordTypeVisibilities || []);
                            renderCustomPermissions(currentData.customPermissions || []);
                            isUpdatingUI = false;
                        } catch (e) {
                            console.error('Invalid JSON:', e);
                        }
                    }

                    // Toggle add forms
                    function toggleAddForm(formId) {
                        const form = document.getElementById(formId);
                        form.classList.toggle('active');
                        // Clear inputs when closing
                        if (!form.classList.contains('active')) {
                            form.querySelectorAll('input[type="text"]').forEach(input => input.value = '');
                        }
                    }

                    // Add Object Permission
                    function addObjectPermission() {
                        let objName = document.getElementById('newObjName').value.trim();
                        const customName = document.getElementById('customObjName').value.trim();
                        
                        // Use custom name if provided, otherwise use selected
                        if (customName) {
                            objName = customName;
                        }
                        
                        if (!objName) {
                            alert('Please select an object or enter a custom object name');
                            return;
                        }
                        
                        // Check for duplicates
                        if (!currentData.objectPermissions) currentData.objectPermissions = [];
                        const exists = currentData.objectPermissions.some(p => p.object === objName);
                        if (exists) {
                            alert('This object permission already exists');
                            return;
                        }
                        
                        // Add new permission with default values
                        currentData.objectPermissions.push({
                            object: objName,
                            allowRead: false,
                            allowCreate: false,
                            allowEdit: false,
                            allowDelete: false,
                            viewAllRecords: false,
                            modifyAllRecords: false
                        });
                        
                        toggleAddForm('objAddForm');
                        renderObjects(currentData.objectPermissions);
                        updateState();
                    }

                    // Add Field Permission
                    function addFieldPermission() {
                        const fieldName = document.getElementById('newFieldName').value.trim();
                        if (!fieldName) {
                            alert('Field API Name is required');
return;
                        }
                        
                        // Validate format (should be Object.Field)
                        if (!fieldName.includes('.')) {
                            alert('Field API Name must be in format: Object.Field (e.g., Account.CustomField__c)');
                            return;
                        }
                        
                        // Check for duplicates
                        if (!currentData.fieldPermissions) currentData.fieldPermissions = [];
                        const exists = currentData.fieldPermissions.some(p => p.field === fieldName);
                        if (exists) {
                            alert('This field permission already exists');
                            return;
                        }
                        
                        // Add new permission with default values
                        currentData.fieldPermissions.push({
                            field: fieldName,
                            readable: false,
                            editable: false
                        });
                        
                        toggleAddForm('fieldAddForm');
                        renderFields(currentData.fieldPermissions);
                        updateState();
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

                    // User Permissions
                    function renderUserPermissions(perms) {
                        const tbody = document.getElementById('userBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${p.name}</td>
                                <td><input type="checkbox" \${p.enabled === true || p.enabled === 'true' ? 'checked' : ''} onchange="updateUserPerm(\${index}, 'enabled', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateUserPerm(index, field, value) {
                        if (!currentData.userPermissions) currentData.userPermissions = [];
                        currentData.userPermissions[index][field] = value;
                        updateState();
                    }

                    // Visualforce Pages
                    function renderPages(perms) {
                        const tbody = document.getElementById('pageBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${p.apexPage}</td>
                                <td><input type="checkbox" \${p.enabled === true || p.enabled === 'true' ? 'checked' : ''} onchange="updatePagePerm(\${index}, 'enabled', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updatePagePerm(index, field, value) {
                        if (!currentData.pageAccesses) currentData.pageAccesses = [];
                        currentData.pageAccesses[index][field] = value;
                        updateState();
                    }

                    // Tab Settings
                    function renderTabs(perms) {
                        const tbody = document.getElementById('tabBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${p.tab}</td>
                                <td>
                                    <select onchange="updateTabPerm(\${index}, 'visibility', this.value)">
                                        <option value="DefaultOn" \${p.visibility === 'DefaultOn' ? 'selected' : ''}>Default On</option>
                                        <option value="DefaultOff" \${p.visibility === 'DefaultOff' ? 'selected' : ''}>Default Off</option>
                                        <option value="Hidden" \${p.visibility === 'Hidden' ? 'selected' : ''}>Hidden</option>
                                    </select>
                                </td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateTabPerm(index, field, value) {
                        if (!currentData.tabSettings) currentData.tabSettings = [];
                        currentData.tabSettings[index][field] = value;
                        updateState();
                    }

                    // Applications
                    function renderApps(perms) {
                        const tbody = document.getElementById('appBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${p.application}</td>
                                <td><input type="checkbox" \${p.visible === true || p.visible === 'true' ? 'checked' : ''} onchange="updateAppPerm(\${index}, 'visible', this.checked)"></td>
                                <td><input type="checkbox" \${p.default === true || p.default === 'true' ? 'checked' : ''} onchange="updateAppPerm(\${index}, 'default', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateAppPerm(index, field, value) {
                        if (!currentData.applicationVisibilities) currentData.applicationVisibilities = [];
                        currentData.applicationVisibilities[index][field] = value;
                        updateState();
                    }

                    // Record Types
                    function renderRecordTypes(perms) {
                        const tbody = document.getElementById('rtBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const parts = p.recordType.split('.');
                            const objName = parts.length > 1 ? parts[0] : '';
                            const rtName = parts.length > 1 ? parts[1] : p.recordType;

                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${rtName}</td>
                                <td>\${objName}</td>
                                <td><input type="checkbox" \${p.visible === true || p.visible === 'true' ? 'checked' : ''} onchange="updateRTPerm(\${index}, 'visible', this.checked)"></td>
                                <td><input type="checkbox" \${p.default === true || p.default === 'true' ? 'checked' : ''} onchange="updateRTPerm(\${index}, 'default', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateRTPerm(index, field, value) {
                        if (!currentData.recordTypeVisibilities) currentData.recordTypeVisibilities = [];
                        currentData.recordTypeVisibilities[index][field] = value;
                        updateState();
                    }

                    // Custom Permissions
                    function renderCustomPermissions(perms) {
                        const tbody = document.getElementById('cpBody');
                        tbody.innerHTML = '';
                        perms.forEach((p, index) => {
                            const row = document.createElement('tr');
                            row.innerHTML = \`
                                <td>\${p.name}</td>
                                <td><input type="checkbox" \${p.enabled === true || p.enabled === 'true' ? 'checked' : ''} onchange="updateCPPerm(\${index}, 'enabled', this.checked)"></td>
                            \`;
                            tbody.appendChild(row);
                        });
                    }

                    function updateCPPerm(index, field, value) {
                        if (!currentData.customPermissions) currentData.customPermissions = [];
                        currentData.customPermissions[index][field] = value;
                        updateState();
                    }
                </script>
            </body>
            </html>
        `;
    }
}
