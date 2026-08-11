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
					this.createItem("Pull Source (Force)", "adure-sfx-toolkit.pullSourceForce", "alert", "Force pull source (overwrite conflicts)"),
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
				this.createItem("Apex Coverage", "adure-sfx-toolkit.openApexCoverage", "shield", "Org-wide Apex coverage — worst-first table, with % badges in the Explorer"),
				this.createItem("Toggle Coverage Line Highlights", "adure-sfx-toolkit.toggleApexCoverageLines", "list-selection", "Show/hide covered & uncovered line highlights in Apex files (stays live while on)"),
				this.createItem("Toggle Coverage % Badge", "adure-sfx-toolkit.toggleApexCoverageBadge", "eye", "Show/hide the coverage % badge on files in the Explorer (coverage stays on hover)"),
				this.createItem("Clear Test Results", "adure-sfx-toolkit.clearApexTestResults", "clear-all", "Delete local .sfdx/tools/testresults and clear coverage"),
			]),
			new DevGroupItem("Query & API", "database", [
				this.createItem("SOQL Builder & Editor", "adure-sfx-toolkit.openSOQLEditor", "database", "Build and run SOQL queries"),
				this.createItem("Object Visualizer", "adure-sfx-toolkit.objectVisualizer", "type-hierarchy", "Render an ERD of objects and their 1-hop relationships"),
				this.createItem("Process Visualizer", "adure-sfx-toolkit.processMap", "circuit-board", "Map the org's automation — triggers, flows, rules, jobs — connected to their objects"),
					this.createItem("REST / API Explorer", "adure-sfx-toolkit.restExplorer", "globe", "Send REST/Tooling API requests to an org"),
			]),
			new DevGroupItem("Tools", "tools", [
				this.createItem("ASFX Workbench", "adure-sfx-toolkit.apexWorkbench.focus", "beaker", "Open the ASFX Workbench (org-aware logs, traces, execute & SOQL)"),
				this.createItem("Refresh Org Metadata", "adure-sfx-toolkit.refreshMetadata", "refresh", "Refresh sobject/field cache for SOQL and builders"),
				this.createItem("Apex Snippets", "adure-sfx-toolkit.showSnippets", "play", "Run, add, edit or delete Apex snippets"),
				this.createItem("Apex Snippets Overview", "adure-sfx-toolkit.openSnippetsPanel", "list-unordered", "Open panel with all snippets"),
				this.createItem("Data Migration Wizard", "adure-sfx-toolkit.dataMigration", "arrow-swap", "Copy records between orgs — parent/child relationships are re-linked to the migrated records"),
				this.createItem("Data Export / Import", "adure-sfx-toolkit.dataTools", "database", "Export records to CSV/JSON and import them back into an org"),
				this.createItem("Org Health", "adure-sfx-toolkit.orgHealth", "dashboard", "View org limits and health metrics"),
				this.createItem("Hide/Show -meta.xml Files", "adure-sfx-toolkit.toggleHideMetaXml", "eye-closed", "Toggle hiding Apex .cls-meta.xml / .trigger-meta.xml files in the Explorer"),
			]),
			// Opt-in fixes for a broken local setup. Nothing here runs on its own — each item
			// writes to the workspace only when you ask for it.
			new DevGroupItem("Repair", "tools", [
				this.createItem("Repair LWC jsconfig", "adure-sfx-toolkit.repairLwcJsconfig", "wrench", "Fix each lwc folder's jsconfig.json so c/* imports, component subdirectories and Salesforce typings resolve in IntelliSense (reload the window afterwards)"),
				this.createItem("Regenerate LWC Apex Typings", "adure-sfx-toolkit.generateLwcApexTypings", "symbol-interface", "Rewrite the @salesforce/apex typings from your Apex @AuraEnabled signatures (real parameter and return types instead of any)"),
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
