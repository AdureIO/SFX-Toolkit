import * as vscode from 'vscode';
import { ScratchOrgDefinition, validateDefinition, ALL_FEATURES } from './scratchOrgDefSchema';
import * as scratchOrgDefSchema from './scratchOrgDefSchema';

export class ScratchOrgDefEditorProvider implements vscode.CustomTextEditorProvider {

    private _isApplyingEdit = false;

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new ScratchOrgDefEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            'adure-sfx-toolkit.scratchOrgDefEditor',
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {

        webviewPanel.webview.options = { enableScripts: true };

        let currentDef: ScratchOrgDefinition = {};
        try {
            const text = document.getText();
            if (text.trim()) currentDef = JSON.parse(text);
        } catch (e) {
            vscode.window.showErrorMessage('Failed to parse scratch org definition file');
        }

        // Initial data is embedded in the HTML itself — no postMessage timing issues
        webviewPanel.webview.html = this.getHtmlForWebview(currentDef);

        const messageListener = webviewPanel.webview.onDidReceiveMessage(message => {
            switch (message.type) {
                case 'update':
                    this.updateDocument(document, message.data);
                    break;
                case 'validate':
                    const errors = validateDefinition(message.data);
                    webviewPanel.webview.postMessage({ type: 'validationResult', errors });
                    break;
                case 'openTextEditor':
                    vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                    break;
            }
        });

        // Reflect external edits (e.g. from text editor) — skip changes we caused ourselves
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (this._isApplyingEdit) return;
            if (e.document.uri.toString() !== document.uri.toString()) return;
            try {
                const newDef = JSON.parse(e.document.getText());
                webviewPanel.webview.postMessage({ type: 'update', data: newDef });
            } catch {
                // ignore mid-edit parse errors
            }
        });

        webviewPanel.onDidDispose(() => {
            messageListener.dispose();
            changeDocumentSubscription.dispose();
        });
    }

    private async updateDocument(document: vscode.TextDocument, newData: ScratchOrgDefinition): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            JSON.stringify(newData, null, 2)
        );
        this._isApplyingEdit = true;
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            this._isApplyingEdit = false;
        }
    }

    private getHtmlForWebview(initialDef: ScratchOrgDefinition = {}): string {
        const initialDataEscaped = JSON.stringify(initialDef)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Scratch Org Definition Editor</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 0; margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 12px;
            background-color: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
        }
        .toolbar-title { font-size: 12px; opacity: 0.75; }
        .toolbar-spacer { flex: 1; }
        .btn {
            padding: 4px 11px;
            font-size: 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; cursor: pointer; border-radius: 2px;
        }
        .btn:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn.secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .container { padding: 16px; max-width: 900px; }
        .tabs {
            display: flex; gap: 5px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            margin-bottom: 20px;
        }
        .tab {
            padding: 8px 16px; cursor: pointer;
            border: none; background: transparent;
            color: var(--vscode-foreground);
            border-bottom: 2px solid transparent;
        }
        .tab:hover { background-color: var(--vscode-list-hoverBackground); }
        .tab.active {
            border-bottom-color: var(--vscode-focusBorder);
            color: var(--vscode-focusBorder);
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .form-group { margin-bottom: 18px; }
        label { display: block; margin-bottom: 4px; font-weight: 500; }
        input[type="text"], input[type="email"], input[type="number"], select, textarea {
            width: 100%; padding: 6px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            box-sizing: border-box;
        }
        input[type="checkbox"] { margin-right: 8px; }
        .feature-item {
            display: flex; align-items: center;
            padding: 6px 8px; margin: 3px 0;
            background-color: var(--vscode-list-inactiveSelectionBackground);
            border-radius: 3px;
        }
        .feature-item input[type="number"] { width: 80px; margin-left: 10px; }
        .feature-description {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-left: auto; padding-left: 10px;
        }
        .settings-category {
            margin-bottom: 10px;
            padding: 8px;
            background-color: var(--vscode-list-inactiveSelectionBackground);
            border-radius: 3px;
        }
        .settings-category-label { font-weight: 600; margin-bottom: 6px; }
        .settings-option { margin-left: 16px; margin-top: 4px; }
        .error {
            color: var(--vscode-errorForeground);
            padding: 10px; margin: 10px 0;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }
    </style>
</head>
<body>
    <script type="application/json" id="initial-data">${initialDataEscaped}</script>

    <div class="toolbar">
        <span class="toolbar-title">Scratch Org Definition</span>
        <div class="toolbar-spacer"></div>
        <button class="btn secondary" id="open-text-btn" title="Open in standard JSON text editor">Edit as JSON</button>
    </div>

    <div class="container">
        <div class="tabs">
            <button class="tab active" data-tab="general">General</button>
            <button class="tab" data-tab="features">Features</button>
            <button class="tab" data-tab="settings">Settings</button>
            <button class="tab" data-tab="advanced">Advanced</button>
        </div>

        <!-- General Tab -->
        <div class="tab-content active" id="general-tab">
            <div class="form-group">
                <label for="orgName">Org Name</label>
                <input type="text" id="orgName" placeholder="My Scratch Org">
            </div>
            <div class="form-group">
                <label for="edition">Edition *</label>
                <select id="edition">
                    <option value="">Select Edition...</option>
                    <option value="Developer">Developer</option>
                    <option value="Enterprise">Enterprise</option>
                    <option value="Group">Group</option>
                    <option value="Professional">Professional</option>
                    <option value="Partner Developer">Partner Developer</option>
                    <option value="Partner Enterprise">Partner Enterprise</option>
                </select>
            </div>
            <div class="form-group">
                <label for="country">Country</label>
                <input type="text" id="country" placeholder="US" maxlength="2">
            </div>
            <div class="form-group">
                <label for="language">Language</label>
                <select id="language">
                    <option value="en_US">English (US)</option>
                    <option value="en_GB">English (UK)</option>
                    <option value="de">German</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="it">Italian</option>
                    <option value="ja">Japanese</option>
                </select>
            </div>
            <div class="form-group">
                <label for="username">Username</label>
                <input type="text" id="username" placeholder="admin@company.com">
            </div>
            <div class="form-group">
                <label for="adminEmail">Admin Email</label>
                <input type="email" id="adminEmail" placeholder="admin@company.com">
            </div>
            <div class="form-group">
                <label for="description">Description</label>
                <textarea id="description" rows="3"></textarea>
            </div>
            <div class="form-group">
                <label style="display:flex;align-items:center;font-weight:normal">
                    <input type="checkbox" id="hasSampleData">
                    Include Sample Data
                </label>
            </div>
        </div>

        <!-- Features Tab -->
        <div class="tab-content" id="features-tab">
            <div class="form-group">
                <input type="text" id="featureSearch" placeholder="Search features...">
            </div>
            <div id="featuresList"></div>
        </div>

        <!-- Settings Tab -->
        <div class="tab-content" id="settings-tab">
            <p style="color: var(--vscode-descriptionForeground); margin-top:0">Configure org-specific settings.</p>
            <div id="settingsList"></div>
        </div>

        <!-- Advanced Tab -->
        <div class="tab-content" id="advanced-tab">
            <div class="form-group">
                <label for="snapshot">Snapshot Org ID</label>
                <input type="text" id="snapshot" placeholder="00D...">
            </div>
            <div class="form-group">
                <label for="release">Release</label>
                <select id="release">
                    <option value="">Default</option>
                    <option value="Preview">Preview</option>
                    <option value="Previous">Previous</option>
                </select>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Read initial data embedded in the HTML — no postMessage race condition
        let currentData = {};
        try {
            const el = document.getElementById('initial-data');
            if (el) currentData = JSON.parse(el.textContent);
        } catch(e) {}

        let isUpdatingUI = false;

        // Feature definitions from extension
        const features = ${JSON.stringify(ALL_FEATURES)};
        let filteredFeatures = features;

        // Settings schema
        const settingsSchema = ${JSON.stringify(scratchOrgDefSchema.SETTINGS_CATEGORIES)};

        // Authoritative enabled-features map: name → param string or null
        // Decoupled from DOM so search filtering never drops enabled features
        let enabledFeatures = new Map();

        function syncEnabledFeaturesFromData(data) {
            enabledFeatures.clear();
            (data.features || []).forEach(f => {
                const ci = f.indexOf(':');
                if (ci > -1) {
                    enabledFeatures.set(f.substring(0, ci), f.substring(ci + 1));
                } else {
                    enabledFeatures.set(f, null);
                }
            });
        }

        // Debounce for general field changes — avoids a write per keystroke
        let _collectTimer;
        function scheduleCollect() {
            if (isUpdatingUI) return;
            clearTimeout(_collectTimer);
            _collectTimer = setTimeout(collectData, 200);
        }

        // External document change (e.g. user edited via text editor)
        // Only updates field values and visible checkboxes — no DOM rebuild
        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'update') {
                currentData = msg.data || {};
                isUpdatingUI = true;
                syncEnabledFeaturesFromData(currentData);
                updateUIFields();
                syncFeatureCheckboxes();
                syncSettingCheckboxes();
                isUpdatingUI = false;
            } else if (msg.type === 'validationResult') {
                handleValidationResult(msg.errors);
            }
        });

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
            });
        });

        document.getElementById('open-text-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openTextEditor' });
        });

        // Full UI render — called once on init from embedded data
        function updateUI() {
            isUpdatingUI = true;
            syncEnabledFeaturesFromData(currentData);
            updateUIFields();
            filteredFeatures = features;
            const searchEl = document.getElementById('featureSearch');
            if (searchEl) searchEl.value = '';
            renderFeatures();
            renderSettings();
            isUpdatingUI = false;
        }

        function updateUIFields() {
            document.getElementById('orgName').value = currentData.orgName || '';
            document.getElementById('edition').value = currentData.edition || '';
            document.getElementById('country').value = currentData.country || '';
            document.getElementById('language').value = currentData.language || 'en_US';
            document.getElementById('username').value = currentData.username || '';
            document.getElementById('adminEmail').value = currentData.adminEmail || '';
            document.getElementById('description').value = currentData.description || '';
            document.getElementById('hasSampleData').checked = !!currentData.hasSampleData;
            document.getElementById('snapshot').value = currentData.snapshot || '';
            document.getElementById('release').value = currentData.release || '';
        }

        // Update only visible feature checkboxes without rebuilding the list
        function syncFeatureCheckboxes() {
            filteredFeatures.forEach(feature => {
                const cb = document.getElementById('feature-' + feature.name);
                if (!cb) return;
                cb.checked = enabledFeatures.has(feature.name);
                if (feature.hasParams) {
                    const inp = document.getElementById('param-' + feature.name);
                    if (inp) inp.value = enabledFeatures.get(feature.name) || '';
                }
            });
        }

        // Update visible settings checkboxes without rebuilding the list
        function syncSettingCheckboxes() {
            Object.keys(settingsSchema).forEach(category => {
                const info = settingsSchema[category];
                (info.commonOptions || []).forEach(option => {
                    const cb = document.getElementById('setting-' + category + '-' + option);
                    if (cb) cb.checked = getNestedValue(currentData.settings, category + '.' + option) || false;
                });
            });
        }

        document.getElementById('featureSearch').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            filteredFeatures = term
                ? features.filter(f => f.name.toLowerCase().includes(term) || f.description.toLowerCase().includes(term))
                : features;
            renderFeatures();
        });

        function renderFeatures() {
            const container = document.getElementById('featuresList');
            container.innerHTML = '';
            filteredFeatures.forEach(feature => {
                const div = document.createElement('div');
                div.className = 'feature-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = 'feature-' + feature.name;
                checkbox.checked = enabledFeatures.has(feature.name);
                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        enabledFeatures.set(feature.name, null);
                    } else {
                        enabledFeatures.delete(feature.name);
                    }
                    collectData();
                });

                const label = document.createElement('label');
                label.htmlFor = checkbox.id;
                label.textContent = feature.name;
                label.style.cursor = 'pointer';

                div.appendChild(checkbox);
                div.appendChild(label);

                if (feature.hasParams) {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.id = 'param-' + feature.name;
                    input.placeholder = 'Value';
                    input.value = enabledFeatures.get(feature.name) || '';
                    if (feature.paramMax) { input.max = feature.paramMax; input.min = 0; }
                    input.addEventListener('input', (e) => {
                        if (enabledFeatures.has(feature.name)) {
                            enabledFeatures.set(feature.name, e.target.value);
                        }
                        collectData();
                    });
                    div.appendChild(input);
                }

                const desc = document.createElement('span');
                desc.className = 'feature-description';
                desc.textContent = feature.description;
                div.appendChild(desc);
                container.appendChild(div);
            });
        }

        function renderSettings() {
            const container = document.getElementById('settingsList');
            container.innerHTML = '';
            Object.keys(settingsSchema).forEach(category => {
                const info = settingsSchema[category];
                if (!info.commonOptions || info.commonOptions.length === 0) return;

                const div = document.createElement('div');
                div.className = 'settings-category';

                const catLabel = document.createElement('div');
                catLabel.className = 'settings-category-label';
                catLabel.textContent = info.label;
                div.appendChild(catLabel);

                info.commonOptions.forEach(option => {
                    const row = document.createElement('div');
                    row.className = 'settings-option';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.id = 'setting-' + category + '-' + option;
                    cb.checked = getNestedValue(currentData.settings, category + '.' + option) || false;
                    cb.addEventListener('change', (e) => {
                        if (!currentData.settings) currentData.settings = {};
                        setNestedValue(currentData.settings, category + '.' + option, e.target.checked);
                        collectData();
                    });

                    const lbl = document.createElement('label');
                    lbl.htmlFor = cb.id;
                    lbl.textContent = option;
                    lbl.style.marginLeft = '4px';

                    row.appendChild(cb);
                    row.appendChild(lbl);
                    div.appendChild(row);
                });

                container.appendChild(div);
            });
        }

        function getNestedValue(obj, path) {
            if (!obj) return undefined;
            const keys = path.split('.');
            let cur = obj;
            for (const key of keys) {
                if (cur && typeof cur === 'object' && key in cur) cur = cur[key];
                else return undefined;
            }
            return cur;
        }

        function setNestedValue(obj, path, value) {
            const keys = path.split('.');
            const lastKey = keys.pop();
            let cur = obj;
            for (const key of keys) {
                if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
                cur = cur[key];
            }
            cur[lastKey] = value;
        }

        function collectData() {
            if (isUpdatingUI) return;

            // Spread currentData first to preserve any unknown/custom JSON fields
            const data = Object.assign({}, currentData);

            // Override known general fields from the form
            const orgName = document.getElementById('orgName').value;
            const edition = document.getElementById('edition').value;
            const country = document.getElementById('country').value;
            const language = document.getElementById('language').value;
            const username = document.getElementById('username').value;
            const adminEmail = document.getElementById('adminEmail').value;
            const description = document.getElementById('description').value;
            const hasSampleData = document.getElementById('hasSampleData').checked;
            const snapshot = document.getElementById('snapshot').value;
            const release = document.getElementById('release').value;

            if (orgName) data.orgName = orgName; else delete data.orgName;
            if (edition) data.edition = edition; else delete data.edition;
            if (country) data.country = country; else delete data.country;
            if (language) data.language = language; else delete data.language;
            if (username) data.username = username; else delete data.username;
            if (adminEmail) data.adminEmail = adminEmail; else delete data.adminEmail;
            if (description) data.description = description; else delete data.description;
            if (hasSampleData) data.hasSampleData = true; else delete data.hasSampleData;
            if (snapshot) data.snapshot = snapshot; else delete data.snapshot;
            if (release) data.release = release; else delete data.release;

            // Features come from the Map — survives search filtering without data loss
            if (enabledFeatures.size > 0) {
                data.features = [];
                enabledFeatures.forEach((val, name) => {
                    data.features.push((val !== null && val !== '') ? name + ':' + val : name);
                });
            } else {
                delete data.features;
            }

            // Settings are mutated directly in currentData.settings by the setting checkboxes
            if (data.settings && Object.keys(data.settings).length === 0) delete data.settings;

            currentData = data;
            vscode.postMessage({ type: 'update', data });
        }

        function handleValidationResult(errors) {
            const container = document.getElementById('general-tab');
            let errorDiv = document.getElementById('validation-errors');
            if (!errorDiv) {
                errorDiv = document.createElement('div');
                errorDiv.id = 'validation-errors';
                container.insertBefore(errorDiv, container.firstChild);
            }
            if (!errors || errors.length === 0) {
                errorDiv.innerHTML = '';
                errorDiv.style.display = 'none';
                return;
            }
            errorDiv.style.display = 'block';
            errorDiv.className = 'error';
            errorDiv.innerHTML = '<strong>Validation Errors:</strong><br>' + errors.map(e => '• ' + e).join('<br>');
        }

        // Debounced listeners for general fields
        ['orgName', 'edition', 'country', 'language', 'username', 'adminEmail', 'description', 'hasSampleData', 'snapshot', 'release'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', scheduleCollect);
                el.addEventListener('input', scheduleCollect);
            }
        });

        // Initial render from embedded data
        updateUI();
    </script>
</body>
</html>`;
    }
}
