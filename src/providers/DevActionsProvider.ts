import * as vscode from "vscode";
import { isSalesforceProject } from "../utils/projectUtils";

/** A collapsible section header that carries its own child action items. */
class DevGroupItem extends vscode.TreeItem {
  constructor(label: string, icon: string, public readonly children: vscode.TreeItem[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "adure-dev-group";
  }
}

export class DevActionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
		// Children of a section header.
		if (element instanceof DevGroupItem) return element.children;
		if (element) return [];

		if (!isSalesforceProject()) {
			const item = new vscode.TreeItem("Open an SFDX project", vscode.TreeItemCollapsibleState.None);
			item.tooltip = "Open a folder that contains sfdx-project.json to use Development actions.";
			return [item];
		}

		// Logical sections — the items keep their labels/commands/icons unchanged,
		// they are only grouped together under collapsible headers.
		return [
			new DevGroupItem("Source", "repo", [
				this.createItem("Push Source", "adure-sfx-toolkit.pushSource", "cloud-upload", "Deploy all source to default org"),
				this.createItem("Push Source (Force)", "adure-sfx-toolkit.pushSourceForce", "alert", "Force push source (overwrite conflicts)"),
				this.createItem("Pull Source", "adure-sfx-toolkit.pullSource", "cloud-download", "Retrieve all source from default org"),
				this.createItem("Reset Source Tracking", "adure-sfx-toolkit.resetSourceTracking", "history", "Reset source tracking for default org"),
			]),
			new DevGroupItem("Deploy & Retrieve", "package", [
				this.createItem("Deploy Metadata", "adure-sfx-toolkit.deployMetadata", "package", "Deploy all or selected metadata with test options (Run All, Specified, Validate, No tests)"),
				this.createItem("Deploy Active File", "adure-sfx-toolkit.deployCurrentFile", "file-code", "Deploy the currently open file"),
				this.createItem("Retrieve Active File", "adure-sfx-toolkit.retrieveCurrentFile", "reply", "Retrieve the currently open file"),
				this.createItem("Compare with Org", "adure-sfx-toolkit.metadataDiff", "diff", "Compare local file against org version"),
			]),
			new DevGroupItem("Test", "beaker", [
				this.createItem("Apex Tests (Test Explorer)", "adure-sfx-toolkit.openApexTests", "beaker", "Open the native Testing view — run Apex tests with results & code coverage"),
			]),
			new DevGroupItem("Query & API", "database", [
				this.createItem("SOQL Builder & Editor", "adure-sfx-toolkit.openSOQLEditor", "database", "Build and run SOQL queries"),
				this.createItem("REST / API Explorer", "adure-sfx-toolkit.restExplorer", "globe", "Send REST/Tooling API requests to an org"),
			]),
			new DevGroupItem("Tools", "tools", [
				this.createItem("Refresh Org Metadata", "adure-sfx-toolkit.refreshMetadata", "refresh", "Refresh sobject/field cache for SOQL and builders"),
				this.createItem("Apex Snippets", "adure-sfx-toolkit.showSnippets", "play", "Run, add, edit or delete Apex snippets"),
				this.createItem("Apex Snippets Overview", "adure-sfx-toolkit.openSnippetsPanel", "list-unordered", "Open panel with all snippets"),
				this.createItem("Org Health", "adure-sfx-toolkit.orgHealth", "dashboard", "View org limits and health metrics"),
			]),
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
