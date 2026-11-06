import * as vscode from "vscode";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { isSalesforceProject, NOT_SFDX_PROJECT_MESSAGE } from "../utils/projectUtils";
import { Logger } from "../utils/outputChannel";
import { AuthInfo } from "../utils/authInfo";
import { getToolingApiVersion } from "../utils/constants";
import { getNonce } from "../utils/htmlUtils";

export class PermissionSetEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "adure-sfx-toolkit.permissionSetEditor";

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new PermissionSetEditorProvider(context);
    const providerRegistration = vscode.window.registerCustomEditorProvider(
      PermissionSetEditorProvider.viewType,
      provider
    );
    return providerRegistration;
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    const parser = PermissionSetEditorProvider.createParser();

    // Set while we apply our own edit, so the change listener doesn't echo it back.
    let applyingOwnEdit = false;
    let disposed = false;
    let pendingSync: ReturnType<typeof setTimeout> | undefined;

    const sendDataToWebview = () => {
      if (disposed) return;
      const text = document.getText();
      try {
        if (!text.trim()) {
          void webviewPanel.webview.postMessage({ type: "update", data: {}, xml: text });
          return;
        }
        const jsonObj = parser.parse(text);
        void webviewPanel.webview.postMessage({
          type: "update",
          data: jsonObj.PermissionSet || {},
          xml: text
        });
      } catch (e) {
        Logger.error("Error parsing XML", e);
        void webviewPanel.webview.postMessage({ type: "xml", xml: text });
      }
    };

    const messageListener = webviewPanel.webview.onDidReceiveMessage(async (e) => {
      switch (e?.type) {
        case "ready":
          // Webview (re)loaded — initial open or re-shown after being hidden.
          sendDataToWebview();
          return;
        case "update":
          applyingOwnEdit = true;
          try {
            await this.updateDocument(document, e.data);
          } finally {
            applyingOwnEdit = false;
          }
          if (!disposed) void webviewPanel.webview.postMessage({ type: "xml", xml: document.getText() });
          return;
        case "applyXml": {
          const text = typeof e.text === "string" ? e.text : "";
          try {
            const parsed = parser.parse(text);
            if (!parsed || typeof parsed !== "object" || !parsed.PermissionSet) {
              throw new Error("Root element <PermissionSet> not found.");
            }
          } catch (err: any) {
            void webviewPanel.webview.postMessage({ type: "xmlError", error: err?.message || String(err) });
            return;
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
          await vscode.workspace.applyEdit(edit);
          // The change listener re-sends the parsed data; nothing else to do.
          return;
        }
        case "fetchObjects":
          void this.fetchObjects(webviewPanel.webview);
          return;
      }
    });

    // Reflect external edits (undo/redo, git checkout, text editor) — skip changes we caused ourselves.
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (applyingOwnEdit) return;
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (e.contentChanges.length === 0) return;
      if (pendingSync) clearTimeout(pendingSync);
      pendingSync = setTimeout(() => {
        pendingSync = undefined;
        sendDataToWebview();
      }, 150);
    });

    webviewPanel.onDidDispose(() => {
      disposed = true;
      if (pendingSync) clearTimeout(pendingSync);
      pendingSync = undefined;
      messageListener.dispose();
      changeDocumentSubscription.dispose();
    });
  }

  private static createParser(): XMLParser {
    return new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: true,
      isArray: (name: string) => {
        return (
          [
            "classAccesses",
            "fieldPermissions",
            "objectPermissions",
            "pageAccesses",
            "recordTypeVisibilities",
            "tabSettings",
            "userPermissions",
            "applicationVisibilities",
            "customPermissions",
            "customMetadataTypeAccesses",
            "flowAccesses",
            "externalDataSourceAccesses",
            "customSettingAccesses"
          ].indexOf(name) !== -1
        );
      }
    });
  }

  private async updateDocument(document: vscode.TextDocument, permissionSetData: any) {
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      indentBy: "    "
    });

    const obj = {
      PermissionSet: {
        ...permissionSetData,
        "@_xmlns": "http://soap.sforce.com/2006/04/metadata"
      }
    };

    // XMLBuilder doesn't emit the XML declaration — keep the file's own (or the Salesforce default).
    const existingDecl = /^\s*(<\?xml[^>]*\?>)/.exec(document.getText());
    const declaration = existingDecl ? existingDecl[1] : '<?xml version="1.0" encoding="UTF-8"?>';
    let xmlContent = builder.build(obj);
    xmlContent = declaration + "\n" + xmlContent.replace(/^\s+/, "");
    if (!xmlContent.endsWith("\n")) xmlContent += "\n";

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), xmlContent);

    await vscode.workspace.applyEdit(edit);
  }

  private async fetchObjects(webview: vscode.Webview) {
    try {
      if (!isSalesforceProject()) {
        throw new Error(NOT_SFDX_PROJECT_MESSAGE);
      }

      Logger.info("Starting to fetch objects and fields...");

      const query = `SELECT EntityDefinition.QualifiedApiName, EntityDefinition.Label, QualifiedApiName, Label, DataType
                          FROM EntityParticle
                          WHERE EntityDefinition.IsCustomizable = true
                          ORDER BY EntityDefinition.QualifiedApiName, QualifiedApiName`;

      Logger.info("Executing Tooling API query...");
      const apiVersion = getToolingApiVersion();

      // Group fields by object (streamed per page so we never hold all raw pages at once)
      const objectsMap = new Map<string, { name: string; label: string; fields: { name: string; label: string; dataType: string }[] }>();
      let total = 0;
      let nextPath: string | null = null;
      let first = true;
      // Hard cap on pages as a safety net against a server that never sets done=true.
      for (let page = 0; page < 500 && (first || nextPath); page++) {
        const pathForPage: string | null = nextPath;
        const { body: resultStr } = await AuthInfo.get(null, (a) => {
          const base = a.instanceUrl.replace(/\/$/, "");
          if (first) {
            Logger.info("Using org: " + (a.alias || a.username));
            return `${base}/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(query)}`;
          }
          return base + pathForPage;
        });
        first = false;
        const parsed = JSON.parse(resultStr);

        if (parsed.records === undefined) {
          const err = parsed[0] || parsed;
          const msg = err.message || err.errorDescription || "Query failed";
          Logger.error("Query failed: " + msg);
          throw new Error(msg);
        }

        total += parsed.records.length;
        for (const record of parsed.records) {
          const objectName = record.EntityDefinition?.QualifiedApiName;
          if (!objectName) continue;
          const objectLabel = record.EntityDefinition.Label;

          let entry = objectsMap.get(objectName);
          if (!entry) {
            entry = { name: objectName, label: objectLabel || objectName, fields: [] };
            objectsMap.set(objectName, entry);
          }
          entry.fields.push({
            name: record.QualifiedApiName,
            label: record.Label || record.QualifiedApiName,
            dataType: record.DataType
          });
        }

        nextPath = !parsed.done && typeof parsed.nextRecordsUrl === "string" ? parsed.nextRecordsUrl : null;
      }

      Logger.info("Received " + total + " field records");

      const objectsWithFields = Array.from(objectsMap.values());
      Logger.info("Prepared " + objectsWithFields.length + " objects with fields");

      void webview.postMessage({
        type: "objectsTree",
        data: objectsWithFields
      });
    } catch (error: any) {
      Logger.error("Failed to fetch objects", error);

      try {
        void webview.postMessage({
          type: "objectsTree",
          data: [],
          error: error.message || "Failed to load objects and fields"
        });
      } catch {
        /* panel closed while loading */
      }
    }
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    const nonce = getNonce();
    return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <style>
                    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                    .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 10px; flex-wrap: wrap; }
                    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; opacity: 0.7; }
                    .tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
                    .tab.active { border-bottom: 2px solid var(--vscode-activityBar-activeBorder); opacity: 1; font-weight: bold; }
                    .content { display: none !important; }
                    .content.active { display: block !important; }
                    input[type="text"], textarea { width: 100%; padding: 8px; margin-bottom: 10px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); box-sizing: border-box; }
                    textarea { font-family: 'Courier New', monospace; font-size: 12px; }
                    select { padding: 6px; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); }
                    input[type="checkbox"] { cursor: pointer; }
                    .btn { padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 3px; }
                    .btn:disabled { opacity: 0.5; cursor: default; }
                    .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                    .xml-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
                    .xml-status { font-size: 12px; opacity: 0.8; }
                    .xml-status.error { color: var(--vscode-errorForeground); opacity: 1; }

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
                    .tree label { margin-left: 8px; cursor: pointer; }
                    .loading { padding: 20px; text-align: center; opacity: 0.7; }
                    .loading.error { color: var(--vscode-errorForeground); opacity: 1; }

                    /* Table styles for other tabs */
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
                    th { font-weight: bold; opacity: 0.8; }
                    tr:hover { background-color: var(--vscode-list-hoverBackground); }
                </style>
            </head>
            <body>
                <div class="tabs" id="tabBar">
                    <div class="tab active" data-tab="objectPerms">Object Permissions</div>
                    <div class="tab" data-tab="objectsFields">Objects & Fields (Org)</div>
                    <div class="tab" data-tab="fields">Field Permissions</div>
                    <div class="tab" data-tab="classes">Apex Classes</div>
                    <div class="tab" data-tab="user">User Permissions</div>
                    <div class="tab" data-tab="pages">Visualforce Pages</div>
                    <div class="tab" data-tab="tabs">Tabs</div>
                    <div class="tab" data-tab="apps">Applications</div>
                    <div class="tab" data-tab="recordTypes">Record Types</div>
                    <div class="tab" data-tab="customPerms">Custom Permissions</div>
                    <div class="tab" data-tab="xml">XML</div>
                </div>

                <!-- Object Permissions (default tab) -->
                <div id="objectPerms" class="content active">
                    <div id="objStatus" style="padding: 8px; margin-bottom: 8px; opacity: 0.7; font-size: 12px;">Loading permission data...</div>
                    <input type="text" placeholder="Search Objects..." data-filter-table="objTable">
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

                <!-- Field Permissions -->
                <div id="fields" class="content">
                    <input type="text" placeholder="Search Fields..." data-filter-table="fieldTable">
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
                    <input type="text" placeholder="Search Classes..." data-filter-table="classTable">
                    <table id="classTable">
                        <thead><tr><th>Apex Class</th><th>Enabled</th></tr></thead>
                        <tbody id="classBody"></tbody>
                    </table>
                </div>

                <!-- User Permissions -->
                <div id="user" class="content">
                    <input type="text" placeholder="Search User Permissions..." data-filter-table="userTable">
                    <table id="userTable">
                        <thead><tr><th>Permission</th><th>Enabled</th></tr></thead>
                        <tbody id="userBody"></tbody>
                    </table>
                </div>

                <!-- Visualforce Pages -->
                <div id="pages" class="content">
                    <input type="text" placeholder="Search Pages..." data-filter-table="pageTable">
                    <table id="pageTable">
                        <thead><tr><th>Visualforce Page</th><th>Enabled</th></tr></thead>
                        <tbody id="pageBody"></tbody>
                    </table>
                </div>

                <!-- Tab Settings -->
                <div id="tabs" class="content">
                    <input type="text" placeholder="Search Tabs..." data-filter-table="tabTable">
                    <table id="tabTable">
                        <thead><tr><th>Tab</th><th>Visibility</th></tr></thead>
                        <tbody id="tabBody"></tbody>
                    </table>
                </div>

                <!-- Applications -->
                <div id="apps" class="content">
                    <input type="text" placeholder="Search Applications..." data-filter-table="appTable">
                    <table id="appTable">
                        <thead><tr><th>Application</th><th>Visible</th><th>Default</th></tr></thead>
                        <tbody id="appBody"></tbody>
                    </table>
                </div>

                <!-- Record Types -->
                <div id="recordTypes" class="content">
                    <input type="text" placeholder="Search Record Types..." data-filter-table="rtTable">
                    <table id="rtTable">
                        <thead><tr><th>Record Type</th><th>Object</th><th>Visible</th><th>Default</th></tr></thead>
                        <tbody id="rtBody"></tbody>
                    </table>
                </div>

                <!-- Custom Permissions -->
                <div id="customPerms" class="content">
                    <input type="text" placeholder="Search Custom Permissions..." data-filter-table="cpTable">
                    <table id="cpTable">
                        <thead><tr><th>Custom Permission</th><th>Enabled</th></tr></thead>
                        <tbody id="cpBody"></tbody>
                    </table>
                </div>

                <!-- Objects & Fields Tree (loads from org on demand) -->
                <div id="objectsFields" class="content">
                    <button id="loadObjBtn" class="btn" style="margin-bottom: 12px;">Load Objects & Fields from Org</button>
                    <input type="text" id="objFieldSearch" placeholder="Search objects and fields..." style="display:none;">
                    <div id="objectsTree" class="tree"></div>
                </div>

                <!-- XML Tab -->
                <div id="xml" class="content">
                    <div class="xml-toolbar">
                        <button id="xmlApplyBtn" class="btn" disabled>Apply</button>
                        <button id="xmlRevertBtn" class="btn secondary" disabled>Revert</button>
                        <span id="xmlStatus" class="xml-status"></span>
                    </div>
                    <textarea id="xmlEditor" rows="25" spellcheck="false"></textarea>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    let currentData = {};
                    let isUpdatingUI = false;
                    let allObjectsTree = [];
                    let objectsLoaded = false;
                    let documentXml = '';
                    let xmlDirty = false;
                    // Tree checkbox lookup by API name (avoids building element ids from org data)
                    const objCheckboxes = new Map();
                    const fieldCheckboxes = new Map();

                    function el(tag, opts) {
                        const node = document.createElement(tag);
                        if (opts) {
                            if (opts.className) node.className = opts.className;
                            if (opts.text !== undefined) node.textContent = String(opts.text);
                        }
                        return node;
                    }
                    function isTrue(v) { return v === true || v === 'true'; }
                    function textCell(value) { return el('td', { text: value == null ? '' : value }); }
                    function checkboxCell(section, index, field, value) {
                        const td = el('td');
                        const cb = el('input');
                        cb.type = 'checkbox';
                        cb.checked = isTrue(value);
                        cb.dataset.perm = section;
                        cb.dataset.index = String(index);
                        cb.dataset.field = field;
                        td.appendChild(cb);
                        return td;
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'update') {
                            currentData = message.data || {};
                            render();
                            if (typeof message.xml === 'string') setDocumentXml(message.xml);
                            if (objectsLoaded) syncTreeWithCurrentData();
                        } else if (message.type === 'xml') {
                            setDocumentXml(message.xml || '');
                        } else if (message.type === 'xmlError') {
                            setXmlStatus('Invalid XML: ' + (message.error || 'parse error'), true);
                        } else if (message.type === 'objectsTree') {
                            allObjectsTree = message.data || [];
                            objectsLoaded = true;
                            const btn = document.getElementById('loadObjBtn');
                            if (btn) btn.style.display = 'none';
                            const searchBox = document.getElementById('objFieldSearch');
                            if (searchBox) searchBox.style.display = '';
                            if (message.error) {
                                const container = document.getElementById('objectsTree');
                                container.textContent = '';
                                container.appendChild(el('div', { className: 'loading error', text: 'Error: ' + message.error }));
                                if (btn) { btn.style.display = ''; btn.textContent = 'Retry'; btn.disabled = false; }
                                objectsLoaded = false;
                            } else {
                                renderObjectsTree();
                            }
                        }
                    });

                    // --- Event wiring (no inline handlers: CSP only allows this nonce'd script) ---
                    document.getElementById('tabBar').addEventListener('click', (e) => {
                        const tab = e.target.closest('.tab');
                        if (tab) openTab(tab.dataset.tab, tab);
                    });
                    document.addEventListener('input', (e) => {
                        const t = e.target;
                        if (t.dataset && t.dataset.filterTable) filterTable(t.dataset.filterTable, t.value);
                        else if (t.id === 'objFieldSearch') filterTree();
                        else if (t.id === 'xmlEditor') {
                            xmlDirty = t.value !== documentXml;
                            updateXmlButtons();
                            setXmlStatus(xmlDirty ? 'Unapplied changes' : '', false);
                        }
                    });
                    document.addEventListener('change', (e) => {
                        const t = e.target;
                        if (!t.dataset) return;
                        if (t.dataset.perm) {
                            const list = currentData[t.dataset.perm];
                            const row = list && list[Number(t.dataset.index)];
                            if (!row) return;
                            row[t.dataset.field] = t.type === 'checkbox' ? t.checked : t.value;
                            updateState();
                        } else if (t.dataset.treeObject !== undefined) {
                            toggleObjectPermissions(t.dataset.treeObject, t.checked);
                        } else if (t.dataset.treeField !== undefined) {
                            toggleFieldPermission(t.dataset.treeFieldObject, t.dataset.treeField, t.checked);
                        }
                    });
                    document.getElementById('loadObjBtn').addEventListener('click', loadObjectsFromOrg);
                    document.getElementById('xmlApplyBtn').addEventListener('click', () => {
                        setXmlStatus('Applying...', false);
                        vscode.postMessage({ type: 'applyXml', text: document.getElementById('xmlEditor').value });
                    });
                    document.getElementById('xmlRevertBtn').addEventListener('click', () => {
                        xmlDirty = false;
                        setDocumentXml(documentXml);
                        setXmlStatus('', false);
                    });

                    function setDocumentXml(xml) {
                        const changed = xml !== documentXml;
                        documentXml = xml;
                        const editor = document.getElementById('xmlEditor');
                        // Don't clobber in-progress edits in the XML tab; external changes win only when clean.
                        if (!xmlDirty) editor.value = xml;
                        else if (changed && editor.value === xml) xmlDirty = false;
                        if (!xmlDirty) setXmlStatus('', false);
                        updateXmlButtons();
                    }
                    function updateXmlButtons() {
                        document.getElementById('xmlApplyBtn').disabled = !xmlDirty;
                        document.getElementById('xmlRevertBtn').disabled = !xmlDirty;
                    }
                    function setXmlStatus(text, isError) {
                        const s = document.getElementById('xmlStatus');
                        s.textContent = text;
                        s.classList.toggle('error', !!isError);
                    }

                    function loadObjectsFromOrg() {
                        if (objectsLoaded) return;
                        const btn = document.getElementById('loadObjBtn');
                        if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
                        const container = document.getElementById('objectsTree');
                        container.textContent = '';
                        container.appendChild(el('div', { className: 'loading', text: 'Fetching objects and fields from org...' }));
                        vscode.postMessage({ type: 'fetchObjects' });
                    }

                    function renderObjectsTree() {
                        const container = document.getElementById('objectsTree');
                        container.textContent = '';
                        objCheckboxes.clear();
                        fieldCheckboxes.clear();
                        if (allObjectsTree.length === 0) {
                            container.appendChild(el('div', { className: 'loading', text: 'No objects found or still loading...' }));
                            return;
                        }

                        const frag = document.createDocumentFragment();
                        allObjectsTree.forEach((obj, oi) => {
                            const objectDiv = el('div', { className: 'tree-object' });

                            // Object header with expand/collapse
                            const header = el('div', { className: 'tree-object-header' });
                            const expand = el('span', { className: 'tree-expand', text: '▶' });
                            const cb = el('input');
                            cb.type = 'checkbox';
                            cb.id = 'tobj_' + oi;
                            cb.dataset.treeObject = obj.name;
                            const label = el('label', { text: obj.name + ' (' + obj.label + ')' });
                            label.htmlFor = cb.id;
                            header.append(expand, cb, label);
                            objCheckboxes.set(obj.name, cb);

                            // Fields container (initially collapsed)
                            const fieldsDiv = el('div', { className: 'tree-object-fields' });
                            expand.addEventListener('click', (e) => {
                                e.stopPropagation();
                                const open = fieldsDiv.classList.toggle('expanded');
                                expand.textContent = open ? '▼' : '▶';
                            });

                            (obj.fields || []).forEach((field, fi) => {
                                const fieldDiv = el('div', { className: 'tree-field' });
                                const fcb = el('input');
                                fcb.type = 'checkbox';
                                fcb.id = 'tfld_' + oi + '_' + fi;
                                fcb.dataset.treeFieldObject = obj.name;
                                fcb.dataset.treeField = field.name;
                                const flabel = el('label', { text: field.name + ' (' + field.label + ') - ' + (field.dataType || '') });
                                flabel.htmlFor = fcb.id;
                                fieldDiv.append(fcb, flabel);
                                fieldsDiv.appendChild(fieldDiv);
                                fieldCheckboxes.set(obj.name + '.' + field.name, fcb);
                            });

                            objectDiv.append(header, fieldsDiv);
                            frag.appendChild(objectDiv);
                        });
                        container.appendChild(frag);

                        // Check existing permissions
                        syncTreeWithCurrentData();
                    }

                    function syncTreeWithCurrentData() {
                        objCheckboxes.forEach(cb => { cb.checked = false; });
                        fieldCheckboxes.forEach(cb => { cb.checked = false; });
                        (currentData.objectPermissions || []).forEach(perm => {
                            const checkbox = objCheckboxes.get(perm.object);
                            if (checkbox) checkbox.checked = true;
                        });
                        (currentData.fieldPermissions || []).forEach(perm => {
                            const checkbox = fieldCheckboxes.get(String(perm.field));
                            if (checkbox) checkbox.checked = true;
                        });
                    }

                    function toggleObjectPermissions(objectName, checked) {
                        if (!currentData.objectPermissions) currentData.objectPermissions = [];

                        if (checked) {
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
                            currentData.objectPermissions = currentData.objectPermissions.filter(p => p.object !== objectName);
                        }

                        renderObjects(currentData.objectPermissions);
                        updateState();
                    }

                    function toggleFieldPermission(objectName, fieldName, checked) {
                        if (!currentData.fieldPermissions) currentData.fieldPermissions = [];

                        const fullFieldName = objectName + '.' + fieldName;

                        if (checked) {
                            const exists = currentData.fieldPermissions.some(p => p.field === fullFieldName);
                            if (!exists) {
                                currentData.fieldPermissions.push({
                                    field: fullFieldName,
                                    readable: true,
                                    editable: false
                                });
                            }
                        } else {
                            currentData.fieldPermissions = currentData.fieldPermissions.filter(p => p.field !== fullFieldName);
                        }

                        renderFields(currentData.fieldPermissions);
                        updateState();
                    }

                    function filterTree() {
                        const filter = document.getElementById('objFieldSearch').value.toUpperCase();
                        document.querySelectorAll('.tree-object').forEach(objDiv => {
                            const objLabel = objDiv.querySelector('.tree-object-header label').textContent;
                            let showObject = objLabel.toUpperCase().indexOf(filter) > -1;
                            objDiv.querySelectorAll('.tree-field label').forEach(fieldLabel => {
                                if (fieldLabel.textContent.toUpperCase().indexOf(filter) > -1) {
                                    fieldLabel.parentElement.style.display = '';
                                    showObject = true;
                                } else {
                                    fieldLabel.parentElement.style.display = 'none';
                                }
                            });
                            objDiv.style.display = showObject ? '' : 'none';
                        });
                    }

                    function render() {
                        try {
                            isUpdatingUI = true;
                            renderObjects(currentData.objectPermissions || []);
                            renderFields(currentData.fieldPermissions || []);
                            renderSimple('classBody', 'classAccesses', 'apexClass', [['enabled']]);
                            renderSimple('userBody', 'userPermissions', 'name', [['enabled']]);
                            renderSimple('pageBody', 'pageAccesses', 'apexPage', [['enabled']]);
                            renderTabs(currentData.tabSettings || []);
                            renderSimple('appBody', 'applicationVisibilities', 'application', [['visible'], ['default']]);
                            renderRecordTypes(currentData.recordTypeVisibilities || []);
                            renderSimple('cpBody', 'customPermissions', 'name', [['enabled']]);
                            reapplyFilters();
                        } catch (err) {
                            const status = document.getElementById('objStatus');
                            if (status) {
                                status.textContent = 'Error rendering: ' + (err.message || err);
                                status.style.color = 'var(--vscode-errorForeground)';
                            }
                        } finally {
                            isUpdatingUI = false;
                        }
                    }

                    function openTab(tabName, clickedTab) {
                        document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
                        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                        const target = document.getElementById(tabName);
                        if (target) target.classList.add('active');
                        if (clickedTab) clickedTab.classList.add('active');
                    }

                    function filterTable(tableId, value) {
                        const filter = String(value || '').toUpperCase();
                        const table = document.getElementById(tableId);
                        if (!table) return;
                        const rows = table.tBodies[0] ? table.tBodies[0].rows : [];
                        for (let i = 0; i < rows.length; i++) {
                            const td = rows[i].cells[0];
                            if (td) rows[i].style.display = td.textContent.toUpperCase().indexOf(filter) > -1 ? '' : 'none';
                        }
                    }
                    function reapplyFilters() {
                        document.querySelectorAll('[data-filter-table]').forEach(input => {
                            if (input.value) filterTable(input.dataset.filterTable, input.value);
                        });
                    }

                    function updateState() {
                        if (!isUpdatingUI) {
                            vscode.postMessage({
                                type: 'update',
                                data: currentData
                            });
                        }
                    }

                    // --- RENDERERS ---

                    function renderObjects(perms) {
                        const status = document.getElementById('objStatus');
                        if (status) status.textContent = perms.length > 0 ? perms.length + ' object(s)' : 'No object permissions in this file';
                        const tbody = document.getElementById('objBody');
                        tbody.textContent = '';
                        const frag = document.createDocumentFragment();
                        perms.forEach((p, index) => {
                            const row = el('tr');
                            row.appendChild(textCell(p.object));
                            ['allowRead', 'allowCreate', 'allowEdit', 'allowDelete', 'viewAllRecords', 'modifyAllRecords'].forEach(f => {
                                row.appendChild(checkboxCell('objectPermissions', index, f, p[f]));
                            });
                            frag.appendChild(row);
                        });
                        tbody.appendChild(frag);
                    }

                    function renderFields(perms) {
                        const tbody = document.getElementById('fieldBody');
                        tbody.textContent = '';
                        const frag = document.createDocumentFragment();
                        perms.forEach((p, index) => {
                            const parts = String(p.field || '').split('.');
                            const objName = parts.length > 1 ? parts[0] : '';
                            const fieldName = parts.length > 1 ? parts[1] : p.field;
                            const row = el('tr');
                            row.append(textCell(fieldName), textCell(objName),
                                checkboxCell('fieldPermissions', index, 'readable', p.readable),
                                checkboxCell('fieldPermissions', index, 'editable', p.editable));
                            frag.appendChild(row);
                        });
                        tbody.appendChild(frag);
                    }

                    /** One name column + N checkbox columns (classes, user perms, pages, apps, custom perms). */
                    function renderSimple(tbodyId, section, nameKey, checkCols) {
                        const perms = currentData[section] || [];
                        const tbody = document.getElementById(tbodyId);
                        tbody.textContent = '';
                        const frag = document.createDocumentFragment();
                        perms.forEach((p, index) => {
                            const row = el('tr');
                            row.appendChild(textCell(p[nameKey]));
                            checkCols.forEach(([f]) => row.appendChild(checkboxCell(section, index, f, p[f])));
                            frag.appendChild(row);
                        });
                        tbody.appendChild(frag);
                    }

                    function renderTabs(perms) {
                        const tbody = document.getElementById('tabBody');
                        tbody.textContent = '';
                        const frag = document.createDocumentFragment();
                        perms.forEach((p, index) => {
                            const row = el('tr');
                            row.appendChild(textCell(p.tab));
                            const td = el('td');
                            const sel = el('select');
                            sel.dataset.perm = 'tabSettings';
                            sel.dataset.index = String(index);
                            sel.dataset.field = 'visibility';
                            [['DefaultOn', 'Default On'], ['DefaultOff', 'Default Off'], ['Hidden', 'Hidden']].forEach(([v, l]) => {
                                const opt = el('option', { text: l });
                                opt.value = v;
                                if (p.visibility === v) opt.selected = true;
                                sel.appendChild(opt);
                            });
                            td.appendChild(sel);
                            row.appendChild(td);
                            frag.appendChild(row);
                        });
                        tbody.appendChild(frag);
                    }

                    function renderRecordTypes(perms) {
                        const tbody = document.getElementById('rtBody');
                        tbody.textContent = '';
                        const frag = document.createDocumentFragment();
                        perms.forEach((p, index) => {
                            const parts = String(p.recordType || '').split('.');
                            const objName = parts.length > 1 ? parts[0] : '';
                            const rtName = parts.length > 1 ? parts[1] : p.recordType;
                            const row = el('tr');
                            row.append(textCell(rtName), textCell(objName),
                                checkboxCell('recordTypeVisibilities', index, 'visible', p.visible),
                                checkboxCell('recordTypeVisibilities', index, 'default', p.default));
                            frag.appendChild(row);
                        });
                        tbody.appendChild(frag);
                    }

                    // Ask the host for the document (initial load and every re-show after the tab was hidden).
                    vscode.postMessage({ type: 'ready' });
                </script>
            </body>
            </html>
        `;
  }
}
