import * as vscode from 'vscode';

export class DevActionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
        if (element) return [];

        // Root items
        return [
            this.createItem("Push Source", "salesforce-utils.pushSource", "cloud-upload", "Deploy all source to default org"),
            this.createItem("Pull Source", "salesforce-utils.pullSource", "cloud-download", "Retrieve all source from default org"),
            this.createItem("Deploy Active File", "salesforce-utils.deployCurrentFile", "file-code", "Deploy the currently open file"),
            this.createItem("Retrieve Active File", "salesforce-utils.retrieveCurrentFile", "reply", "Retrieve the currently open file"),
            this.createItem("Run Local Tests", "salesforce-utils.runLocalTests", "beaker", "Run all local Apex tests")
        ];
    }
    
    private createItem(label: string, commandId: string, icon: string, tooltip: string): vscode.TreeItem {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.command = {
            command: commandId,
            title: label
        };
        item.iconPath = new vscode.ThemeIcon(icon);
        item.tooltip = tooltip;
        return item;
    }
}
