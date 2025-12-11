import * as vscode from 'vscode';
import { ScratchOrgDefinition, validateDefinition, ALL_FEATURES } from './scratchOrgDefSchema';
import * as scratchOrgDefSchema from './scratchOrgDefSchema';

/**
 * Provider for Scratch Org Definition file editor
 */
export class ScratchOrgDefEditorProvider implements vscode.CustomTextEditorProvider {
    
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new ScratchOrgDefEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            'adure-sfx-toolkit.scratchOrgDefEditor',
            provider
        );
        return providerRegistration;
    }

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    /**
     * Called when custom editor is opened
     */
    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        
        // Setup webview options
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        // Set webview HTML content
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Parse current document
        let currentDef: ScratchOrgDefinition = {};
        try {
            const text = document.getText();
            if (text.trim()) {
                currentDef = JSON.parse(text);
            }
        } catch (e) {
            vscode.window.showErrorMessage('Failed to parse scratch org definition file');
        }

        // Send initial data to webview
        webviewPanel.webview.postMessage({
            type: 'init',
            data: currentDef
        });

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'update':
                        this.updateDocument(document, message.data);
                        break;
                    case 'validate':
                        const errors = validateDefinition(message.data);
                        webviewPanel.webview.postMessage({
                            type: 'validationResult',
                            errors
                        });
                        break;
                    case 'openTextEditor':
                        // Open text editor alongside the custom editor (don't dispose)
                        vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                        break;
                }
            }
        );

        // Update webview when document changes externally
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                try {
                    const newDef = JSON.parse(e.document.getText());
                    webviewPanel.webview.postMessage({
                        type: 'update',
                        data: newDef
                    });
                } catch (err) {
                    // Ignore parse errors during editing
                }
            }
        });

        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });
    }

    /**
     * Update the document with new definition
     */
    private updateDocument(document: vscode.TextDocument, newData: ScratchOrgDefinition) {
        const edit = new vscode.WorkspaceEdit();
        
        // Format JSON with 2-space indentation
        const json = JSON.stringify(newData, null, 2);
        
        // Replace entire document
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            json
        );

        return vscode.workspace.applyEdit(edit);
    }

    /**
     * Generate HTML for webview
     */
    private getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scratch Org Definition Editor</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 0;
            margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        
        .toolbar {
            display: flex;
            gap: 10px;
            padding: 10px;
            background-color: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
        }
        
        .btn {
            padding: 6px 14px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            border-radius: 2px;
        }
        
        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .btn.active {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .container {
            padding: 20px;
            max-width: 900px;
        }
        
        .tabs {
            display: flex;
            gap: 5px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            margin-bottom: 20px;
        }
        
        .tab {
            padding: 8px 16px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            border-bottom: 2px solid transparent;
        }
        
        .tab:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .tab.active {
            border-bottom-color: var(--vscode-focusBorder);
            color: var(--vscode-focusBorder);
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
        }
        
        input[type="text"],
        input[type="email"],
        input[type="number"],
        select,
        textarea {
            width: 100%;
            padding: 6px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            box-sizing: border-box;
        }
        
        input[type="checkbox"] {
            margin-right: 8px;
        }
        
        .feature-item {
            display: flex;
            align-items: center;
            padding: 8px;
            margin: 4px 0;
            background-color: var(--vscode-list-inactiveSelectionBackground);
            border-radius: 3px;
        }
        
        .feature-item input[type="number"] {
            width: 80px;
            margin-left: 10px;
        }
        
        .feature-description {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-left: auto;
            padding-left: 10px;
        }
        
        .error {
            color: var(--vscode-errorForeground);
            padding: 10px;
            margin: 10px 0;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="tabs">
            <button class="tab active" data-tab="general">General</button>
            <button class="tab" data-tab="features">Features</button>
            <button class="tab" data-tab="settings">Settings</button>
            <button class="tab" data-tab="advanced">Advanced</button>
            <button class="tab" data-tab="json">JSON</button>
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
                <label>
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
            <p style="color: var(--vscode-descriptionForeground);">Configure org-specific settings...</p>
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
        
        <!-- JSON Tab -->
        <div class="tab-content" id="json-tab">
            <div class="form-group">
                <label for="jsonEditor">Raw JSON</label>
                <textarea id="jsonEditor" rows="20" style="font-family: 'Courier New', monospace; font-size: 12px;"></textarea>
            </div>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let currentData = {};
        let isUpdatingUI = false; // Flag to prevent collectData during UI updates
        
        // Feature definitions (all 200+ features)
        const features = ${JSON.stringify(ALL_FEATURES)};
        let filteredFeatures = features;
        
        // Settings categories (all 80+ categories)
        const scratchOrgDefSchema = {
            SETTINGS_CATEGORIES: ${JSON.stringify(scratchOrgDefSchema.SETTINGS_CATEGORIES)}
        };
        
        // Initialize
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'init':
                case 'update':
                    currentData = message.data || {};
                    updateUI();
                    break;
                case 'validationResult':
                    handleValidationResult(message.errors);
                    break;
            }
        });
        
        // Tab switching with JSON sync
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                
                // Update JSON textarea when switching to JSON tab
                if (tabName === 'json') {
                    updateJsonEditor();
                }
                // Collect data from JSON editor when leaving JSON tab
                else if (document.querySelector('.tab[data-tab="json"]').classList.contains('active')) {
                    parseJsonEditor();
                }
                
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
            });
        });
        
        // Update JSON editor textarea
        function updateJsonEditor() {
            const jsonEditor = document.getElementById('jsonEditor');
            jsonEditor.value = JSON.stringify(currentData, null, 2);
        }
        
        // Parse JSON from editor and update currentData
        function parseJsonEditor() {
            const jsonEditor = document.getElementById('jsonEditor');
            try {
                const parsed = JSON.parse(jsonEditor.value);
                currentData = parsed;
                vscode.postMessage({ type: 'update', data: parsed });
                // Update UI with new data
                isUpdatingUI = true;
                updateUIFields();
                isUpdatingUI = false;
            } catch (e) {
                // Invalid JSON, don't update
                console.error('Invalid JSON:', e);
            }
        }
        
        // JSON editor change listener
        document.addEventListener('DOMContentLoaded', () => {
            const jsonEditor = document.getElementById('jsonEditor');
            if (jsonEditor) {
                jsonEditor.addEventListener('blur', () => {
                    if (document.querySelector('.tab[data-tab="json"]').classList.contains('active')) {
                        parseJsonEditor();
                    }
                });
            }
        });
        
        // Update UI from data
        function updateUI() {
            isUpdatingUI = true;
            updateUIFields();
            // Reset filtered features to show all
            filteredFeatures = features;
            renderFeatures();
            renderSettings();
            isUpdatingUI = false;
        }
        
        // Update just the input fields (helper for JSON tab sync)
        function updateUIFields() {
            document.getElementById('orgName').value = currentData.orgName || '';
            document.getElementById('edition').value = currentData.edition || '';
            document.getElementById('country').value = currentData.country || '';
            document.getElementById('language').value = currentData.language || 'en_US';
            document.getElementById('username').value = currentData.username || '';
            document.getElementById('adminEmail').value = currentData.adminEmail || '';
            document.getElementById('description').value = currentData.description || '';
            document.getElementById('hasSampleData').checked = currentData.hasSampleData || false;
            document.getElementById('snapshot').value = currentData.snapshot || '';
            document.getElementById('release').value = currentData.release || '';
        }
        
        // Feature search
        document.getElementById('featureSearch').addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            filteredFeatures = features.filter(f => 
                f.name.toLowerCase().includes(searchTerm) || 
                f.description.toLowerCase().includes(searchTerm)
            );
            renderFeatures();
        });
        
        // Render features
        function renderFeatures() {
            const container = document.getElementById('featuresList');
            container.innerHTML = '';
            
            // Parse existing features into a map for easier lookup
            const existingFeatures = new Map();
            if (currentData.features) {
                currentData.features.forEach(f => {
                    const colonIdx = f.indexOf(':');
                    if (colonIdx > -1) {
                        const name = f.substring(0, colonIdx);
                        const param = f.substring(colonIdx + 1);
                        existingFeatures.set(name, param);
                    } else {
                        existingFeatures.set(f, null);
                    }
                });
            }
            
            filteredFeatures.forEach(feature => {
                const div = document.createElement('div');
                div.className = 'feature-item';
                
                const isChecked = existingFeatures.has(feature.name);
                const paramValue = existingFeatures.get(feature.name);
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = 'feature-' + feature.name;
                checkbox.checked = isChecked;
                checkbox.addEventListener('change', collectData);
                
                const label = document.createElement('label');
                label.htmlFor = checkbox.id;
                label.textContent = feature.name;
                label.style.cursor = 'pointer';
                
                const desc = document.createElement('span');
                desc.className = 'feature-description';
                desc.textContent = feature.description;
                
                div.appendChild(checkbox);
                div.appendChild(label);
                
                if (feature.hasParams) {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.id = 'param-' + feature.name;
                    input.placeholder = 'Value';
                    input.value = paramValue || '';
                    if (feature.paramMax) {
                        input.max = feature.paramMax;
                        input.min = 0;
                    }
                    input.addEventListener('input', collectData);
                    div.appendChild(input);
                }
                
                div.appendChild(desc);
                container.appendChild(div);
            });
        }
        
        // Render settings with all categories from schema
        function renderSettings() {
            const container = document.getElementById('settingsList');
            container.innerHTML = '';
            
            const settings = currentData.settings || {};
            
            // Import settings categories from schema
            const settingsCategories = Object.keys(scratchOrgDefSchema.SETTINGS_CATEGORIES);
            const categoryLabels = scratchOrgDefSchema.SETTINGS_CATEGORIES;
            
            // Filter to only show categories with common options (actual UI controls)
            const categoriesToShow = settingsCategories.filter(category => {
                const categoryInfo = categoryLabels[category];
                return categoryInfo.commonOptions && categoryInfo.commonOptions.length > 0;
            });
            
            categoriesToShow.forEach(category => {
                const categoryInfo = categoryLabels[category];
                const div = document.createElement('div');
                div.className = 'feature-item';
                div.style.marginBottom = '8px';
                
                const categoryLabel = document.createElement('div');
                categoryLabel.style.fontWeight = '600';
                categoryLabel.style.marginBottom = '4px';
                categoryLabel.textContent = categoryInfo.label;
                div.appendChild(categoryLabel);
                
                // Render common options
                categoryInfo.commonOptions.forEach(option => {
                    const optionDiv = document.createElement('div');
                    optionDiv.style.marginLeft = '16px';
                    optionDiv.style.marginTop = '4px';
                    
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.id = 'setting-' + category + '-' + option;
                    // Handle nested options for checking
                    const isChecked = getNestedValue(currentData.settings, category + '.' + option) || false;
                    checkbox.checked = isChecked;
                    checkbox.addEventListener('change', (e) => {
                        if (!currentData.settings) currentData.settings = {};
                        setNestedValue(currentData.settings, category + '.' + option, e.target.checked);
                        sendUpdate();
                    });
                    
                    const label = document.createElement('label');
                    label.htmlFor = checkbox.id;
                    label.textContent = option;
                    label.style.marginLeft = '4px';
                    
                    optionDiv.appendChild(checkbox);
                    optionDiv.appendChild(label);
                    div.appendChild(optionDiv);
                });
                
                container.appendChild(div);
            });
        }
        
        function getNestedValue(obj, path) {
            const keys = path.split('.');
            let current = obj;
            for (const key of keys) {
                if (current && typeof current === 'object' && key in current) {
                    current = current[key];
                } else {
                    return undefined;
                }
            }
            return current;
        }
        
        function setNestedValue(obj, path, value) {
            const keys = path.split('.');
            const lastKey = keys.pop();
            let current = obj;
            
            for (const key of keys) {
                if (!current[key] || typeof current[key] !== 'object') {
                    current[key] = {};
                }
                current = current[key];
            }
            
            if (value !== undefined) {
                current[lastKey] = value;
            }
        }
        
        function sendUpdate() {
            collectData();
        }
        
        // Collect data from UI
        function collectData() {
            // Don't collect data if we're programmatically updating the UI
            if (isUpdatingUI) return;
            
            const data = {
                orgName: document.getElementById('orgName').value || undefined,
                edition: document.getElementById('edition').value || undefined,
                country: document.getElementById('country').value || undefined,
                language: document.getElementById('language').value || undefined,
                username: document.getElementById('username').value || undefined,
                adminEmail: document.getElementById('adminEmail').value || undefined,
                description: document.getElementById('description').value || undefined,
                hasSampleData: document.getElementById('hasSampleData').checked || undefined,
                snapshot: document.getElementById('snapshot').value || undefined,
                release: document.getElementById('release').value || undefined,
                features: [],
                settings: {}
            };
            
            // Collect features
            features.forEach(feature => {
                const checkbox = document.getElementById('feature-' + feature.name);
                if (checkbox && checkbox.checked) {
                    if (feature.hasParams) {
                        const input = document.getElementById('param-' + feature.name);
                        const param = input ? input.value : '';
                        data.features.push(param ? feature.name + ':' + param : feature.name);
                    } else {
                        data.features.push(feature.name);
                    }
                }
            });
            
            if (data.features.length === 0) {
                delete data.features;
            }
            
            // Collect settings dynamically from rendered checkboxes
            // Settings are already saved in currentData.settings by the change event listeners
            // Just ensure we keep the existing settings structure
            data.settings = currentData.settings || {};
            
            // Remove settings if empty
            if (Object.keys(data.settings).length === 0) {
                delete data.settings;
            }
            
            // Remove undefined top-level properties to avoid cluttering JSON
            // But keep the values that matter
            Object.keys(data).forEach(key => {
                if (data[key] === undefined) {
                    delete data[key];
                }
            });
            
            currentData = data;
            vscode.postMessage({ type: 'update', data });
        }
        
        // Attach change listeners to general inputs
        ['orgName', 'edition', 'country', 'language', 'username', 'adminEmail', 'description', 'hasSampleData', 'snapshot', 'release'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', collectData);
                el.addEventListener('input', collectData);
            }
        });
        
        function handleValidationResult(errors) {
            // TODO: Display validation errors
        }
    </script>
</body>
</html>`;
    }
}
