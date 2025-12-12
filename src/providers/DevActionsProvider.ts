import * as vscode from "vscode";

export class DevActionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
		if (element) return [];

		// Root items
		return [
			this.createItem(
				"Push Source",
				"adure-sfx-toolkit.pushSource",
				"cloud-upload",
				"Deploy all source to default org"
			),
			this.createItem(
				"Push Source (Force)",
				"adure-sfx-toolkit.pushSourceForce",
				"alert",
				"Force push source (overwrite conflicts)"
			),
			this.createItem(
				"Pull Source",
				"adure-sfx-toolkit.pullSource",
				"cloud-download",
				"Retrieve all source from default org"
			),
			this.createItem(
				"Deploy Active File",
				"adure-sfx-toolkit.deployCurrentFile",
				"file-code",
				"Deploy the currently open file"
			),
			this.createItem(
				"Retrieve Active File",
				"adure-sfx-toolkit.retrieveCurrentFile",
				"reply",
				"Retrieve the currently open file"
			),
			this.createItem("Run Local Tests", "adure-sfx-toolkit.runLocalTests", "beaker", "Run all local Apex tests"),
			this.createItem(
				"Reset Source Tracking",
				"adure-sfx-toolkit.resetSourceTracking",
				"history",
				"Reset source tracking for default org"
			),
			this.createItem("SOQL Editor", "adure-sfx-toolkit.openSOQLEditor", "database", "Open SOQL Editor"),
		];
	}

	private createItem(label: string, commandId: string, icon: string, tooltip: string): vscode.TreeItem {
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.command = {
			command: commandId,
			title: label,
		};
		item.iconPath = new vscode.ThemeIcon(icon);
		item.tooltip = tooltip;
		return item;
	}
}
