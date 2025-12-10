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
