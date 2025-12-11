import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';
import { OrgItem, orgTreeProvider } from '../providers/OrgTreeProvider';

export async function openOrg(item: OrgItem) {
    if (!item.orgData || !item.orgData.username) return;
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Opening Org ${item.label}...`,
        cancellable: false
    }, async () => {
        try {
            await runCommand(`sf org open -o ${item.orgData.username}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open org: ${e.message}`);
        }
    });
}

export async function setAsDefault(item: OrgItem) {
    if (!item.orgData || !item.orgData.username) return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting ${item.label} as Default...`,
        cancellable: false
    }, async () => {
        try {
            await runCommand(`sf config set target-org=${item.orgData.username}`);
            vscode.window.showInformationMessage(`Set ${item.label} as default org.`);
            orgTreeProvider.refresh();
            // Update Logs & Traces as they depend on default org/current user
            vscode.commands.executeCommand('adure-sfx-toolkit.refreshLogs');
            vscode.commands.executeCommand('adure-sfx-toolkit.refreshTraces');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to set default: ${e.message}`);
        }
    });
}

export async function setAsDefaultDevHub(item: OrgItem) {
    if (!item.orgData || !item.orgData.username) return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting ${item.label} as Default Dev Hub...`,
        cancellable: false
    }, async () => {
        try {
            await runCommand(`sf config set target-dev-hub=${item.orgData.username}`);
            vscode.window.showInformationMessage(`Set ${item.label} as default Dev Hub.`);
            orgTreeProvider.refresh();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to set default hub: ${e.message}`);
        }
    });
}

export async function copyUsername(item: OrgItem) {
    if (!item.orgData || !item.orgData.username) return;
    await vscode.env.clipboard.writeText(item.orgData.username);
    vscode.window.showInformationMessage(`Copied username: ${item.orgData.username}`);
}

export async function deleteOrg(item: OrgItem) {
    if (!item.orgData || !item.orgData.username) return;
    
    // Check if scratch or regular
    const isScratch = item.contextValue === 'org-scratch';
    const action = isScratch ? 'Deleting Scratch Org' : 'Logging out from Org';
    const cmd = isScratch ? `sf org delete scratch -o ${item.orgData.username} -p` : `sf org logout -o ${item.orgData.username} -p`;

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to ${action.toLowerCase()}?`,
        'Yes', 'No'
    );
    
    if (confirm !== 'Yes') return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `${action}...`,
        cancellable: false
    }, async () => {
        try {
            await runCommand(cmd);
            vscode.window.showInformationMessage(`${action} successful.`);
            orgTreeProvider.refresh();
            vscode.commands.executeCommand('adure-sfx-toolkit.refreshLogs');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed: ${e.message}`);
        }
    });
}

export async function generatePassword(item: OrgItem) {
    if (!item.orgData || !item.orgData.username) return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Generating password for ${item.label}...`,
        cancellable: false
    }, async () => {
        try {
            // Returns JSON with password
            const res = await runCommand(`sf org generate password -o ${item.orgData.username} --json`);
            const json = JSON.parse(res);
            if (json.status === 0 && json.result && json.result.password) {
                // Show password and offering to copy
                const pwd = json.result.password;
                const selection = await vscode.window.showInformationMessage(`Password generated: ${pwd}`, 'Copy to Clipboard');
                if (selection === 'Copy to Clipboard') {
                    await vscode.env.clipboard.writeText(pwd);
                }
            } else {
                 vscode.window.showErrorMessage("Failed to generate password.");
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Error: ${e.message}`);
        }
    });
}

export async function renameAlias(item: OrgItem) {
    if (!item.orgData || !item.orgData.username) return;
    
    // Existing alias
    const oldAlias = typeof item.label === 'string' ? item.label : item.orgData.alias || '';
    
    const newAlias = await vscode.window.showInputBox({
        prompt: `Enter new alias for ${item.orgData.username}`,
        value: oldAlias
    });
    
    if (!newAlias) return;
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting alias...`,
        cancellable: false
    }, async () => {
        try {
            await runCommand(`sf alias set ${newAlias}=${item.orgData.username}`);
            orgTreeProvider.refresh();
        } catch (e: any) {
             vscode.window.showErrorMessage(`Failed to set alias: ${e.message}`);
        }
    });
}

export async function connectOrg() {
    // 1. Ask for Alias
    const alias = await vscode.window.showInputBox({
        prompt: "Enter an alias for the new org",
        placeHolder: "my-org"
    });
    if (!alias) return;

    // 2. Ask for Instance URL
    const urlPick = await vscode.window.showQuickPick(
        [
            { label: 'Production', detail: 'https://login.salesforce.com' },
            { label: 'Sandbox', detail: 'https://test.salesforce.com' },
            { label: 'Custom', detail: 'Enter custom URL' }
        ],
        { placeHolder: "Select Login URL" }
    );
    if (!urlPick) return;

    let instanceUrl = urlPick.detail;
    if (urlPick.label === 'Custom') {
        const customUrl = await vscode.window.showInputBox({
            prompt: "Enter Custom Login URL",
            value: "https://my-domain.my.salesforce.com"
        });
        if (!customUrl) return;
        instanceUrl = customUrl;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Connecting to Org (${alias})... Check your browser.`,
        cancellable: true
    }, async (progress, token) => {
        try {
            await runCommand(`sf org login web --alias ${alias} --instance-url ${instanceUrl} --set-default`);
            vscode.window.showInformationMessage(`Successfully connected to ${alias}.`);
            orgTreeProvider.refresh();
            vscode.commands.executeCommand('adure-sfx-toolkit.refreshLogs');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Connection failed: ${e.message}`);
        }
    });
}

export async function createScratch() {
    try {
        // 1. Dev Hub (With Loader)
        let targetDevHub = '';
        let hubs: any[] = [];
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Fetching Dev Hubs...",
            cancellable: false
        }, async () => {
             try {
                const orgsJson = await runCommand('sf org list --json');
                const orgs = JSON.parse(orgsJson).result;
                hubs = (orgs.nonScratchOrgs || []).filter((o: any) => o.isDevHub);
             } catch (e) {
                 console.error(e);
             }
        });
        
        if (hubs.length === 0) {
            vscode.window.showErrorMessage("No Dev Hubs found. Please authorize a Dev Hub first.");
            return;
        }

        const hubPick = await vscode.window.showQuickPick<vscode.QuickPickItem>(
            hubs.map((h: any) => ({ 
                label: h.alias || h.username, 
                description: h.isDefaultDevHubUsername ? '(Default)' : '', 
                detail: h.username 
            })),
            { placeHolder: 'Select Dev Hub' }
        );
        if (!hubPick) return; // Cancelled
        targetDevHub = hubPick.detail || '';

        // 2. Definition File
        const configFiles = await vscode.workspace.findFiles('config/*.json', '**/node_modules/**');
        let fileUri: vscode.Uri | undefined;
        
        if (configFiles.length === 0) {
            vscode.window.showErrorMessage("No scratch definition files found in config/.");
            return;
        }
        
        const filePick = await vscode.window.showQuickPick(
            configFiles.map(f => {
               const name = vscode.workspace.asRelativePath(f);
               return { label: name, uri: f };
            }),
            { placeHolder: 'Select Definition File' }
        );
        if (!filePick) return;
        fileUri = filePick.uri;

        // READ JSON CONTENT for Defaults
        let defJson: any = {};
        try {
            const content = await vscode.workspace.fs.readFile(fileUri);
            defJson = JSON.parse(content.toString());
        } catch (e) {
            console.warn("Failed to read definition file for defaults", e);
        }

        // 3. Alias (Default to orgName or filename)
        let defaultAlias = defJson.orgName || filePick.label.replace('.json', '');
        // Clean alias if it has spaces
        defaultAlias = defaultAlias.replace(/\s+/g, '-');

        const alias = await vscode.window.showInputBox({ 
            prompt: 'Enter Scratch Org Alias',
            value: defaultAlias,
            placeHolder: 'e.g. feature-x'
        });
        if (!alias) return;

        // 4. Duration
        const duration = await vscode.window.showInputBox({
            prompt: 'Duration (Days)',
            value: '30',
            validateInput: (val) => {
                const n = parseInt(val);
                if (isNaN(n) || n < 1 || n > 30) return "Duration must be between 1 and 30.";
                return null;
            }
        });
        if (!duration) return;

        // Command Construction
        let cmd = `sf org create scratch -f "${fileUri.fsPath}" -a ${alias} --duration-days ${duration} -v ${targetDevHub} --set-default`;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating Scratch Org (${alias})...`,
            cancellable: false
        }, async () => {
             await runCommand(cmd);
             vscode.window.showInformationMessage(`Scratch Org ${alias} created successfully.`);
             orgTreeProvider.refresh();
        });

    } catch (e: any) {
        vscode.window.showErrorMessage("Failed to start scratch creation: " + e.message);
    }
}

export async function quickScratch() {
    try {
        // 1. Definition File
        const configFiles = await vscode.workspace.findFiles('config/*.json', '**/node_modules/**');
        let defFile = '';
        let defFileUri: vscode.Uri | undefined;
        
        if (configFiles.length === 0) {
             vscode.window.showErrorMessage("No definition files found.");
             return;
        } else if (configFiles.length === 1) {
            defFile = configFiles[0].fsPath;
            defFileUri = configFiles[0];
        } else {
             const filePick = await vscode.window.showQuickPick(
                configFiles.map(f => ({ label: vscode.workspace.asRelativePath(f), uri: f })),
                { placeHolder: 'Select Definition File' }
            );
            if (!filePick) return;
            defFile = filePick.uri.fsPath;
            defFileUri = filePick.uri;
        }

        // READ JSON CONTENT for alias/orgName
        let defJson: any = {};
        let defaultAlias = 'quick-scratch';
        try {
            if (defFileUri) {
                const content = await vscode.workspace.fs.readFile(defFileUri);
                defJson = JSON.parse(content.toString());
                // Use orgName from definition, or fallback to filename
                if (defJson.orgName) {
                    defaultAlias = defJson.orgName.replace(/\s+/g, '-');
                } else {
                    defaultAlias = vscode.workspace.asRelativePath(defFileUri).replace('.json', '').replace('config/', '');
                }
            }
        } catch (e) {
            console.warn("Failed to read definition file for alias", e);
        }

        // 2. Alias (with smart default from definition)
        const alias = await vscode.window.showInputBox({
            prompt: 'Enter Scratch Org Alias',
            value: defaultAlias,
            placeHolder: 'e.g. quick-scratch'
        });
        if (!alias) return;

        // 3. Create (Defaults: 30 days, default hub)
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating Quick Scratch Org (${alias})...`,
            cancellable: false
        }, async () => {
             await runCommand(`sf org create scratch -f "${defFile}" -a ${alias} --duration-days 30 --set-default`);
             vscode.window.showInformationMessage(`Scratch Org ${alias} created.`);
             orgTreeProvider.refresh();
        });

    } catch (e: any) {
         vscode.window.showErrorMessage("Error: " + e.message);
    }
}
