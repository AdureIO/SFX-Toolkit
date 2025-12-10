import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';

export class OrgItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly orgData: any, // The JSON object for the org
        public readonly type: 'GROUP' | 'ORG',
        public readonly contextValue: string // 'org-connected', 'org-scratch', etc.
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
        
        if (type === 'ORG') {
            const isScratch = contextValue === 'org-scratch';
            const isDevHub = orgData.isDevHub;
            // Determine Icon & Type
            let typeStr = 'Production / Developer';
            
            if (isDevHub) {
                this.iconPath = new vscode.ThemeIcon('server'); // User requested distinct icon, 'hub' might be subtle
                typeStr = 'Dev Hub';
            } else if (isScratch) {
                 this.iconPath = new vscode.ThemeIcon('beaker');
                 typeStr = 'Scratch Org';
            } else if (orgData.isSandbox) {
                 // Sandbox (Fork of Prod)
                 this.iconPath = new vscode.ThemeIcon('repo-forked'); 
                 typeStr = 'Sandbox';
            } else {
                 // Production or Developer Edition
                 this.iconPath = new vscode.ThemeIcon('briefcase');
            }
            
            // Description: Username + Status
            let desc = orgData.username;
            if (orgData.isDefaultDevHubUsername) {
                desc += ' (Default Hub)';
            }
            if (orgData.isDefaultUsername) {
                desc += ' (Default Org)';
                // Make label bold?
                this.label = label; // VS Code doesn't natively support bold label easily without markdown, but we can highlight
                this.description = desc; 
            } else {
                 this.description = desc;
            }

            // Toolkit for tooltip
            this.tooltip = `Username: ${orgData.username}\nOrgId: ${orgData.orgId}\nStatus: ${orgData.status || 'Connected'}\nType: ${typeStr}`;
            if (isScratch && orgData.expirationDate) {
                this.tooltip += `\nExpires: ${orgData.expirationDate}`;
                this.description += ` [${orgData.expirationDate.split('T')[0]}]`;
            }
        }
    }
}

export class OrgTreeProvider implements vscode.TreeDataProvider<OrgItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<OrgItem | undefined | null | void> = new vscode.EventEmitter<OrgItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<OrgItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private data: any = null;

    constructor() {}

    refresh(): void {
        this.data = null; // Clear cache
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: OrgItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: OrgItem): Promise<OrgItem[]> {
        if (!element) {
            // Root: Check if we have data
            if (!this.data) {
                await this.fetchOrgs();
            }
            // Return Groups
            return [
                new OrgItem("Connected Orgs", vscode.TreeItemCollapsibleState.Expanded, null, 'GROUP', 'group-connected'),
                new OrgItem("Scratch Orgs", vscode.TreeItemCollapsibleState.Expanded, null, 'GROUP', 'group-scratch')
            ];
        }

        if (element.type === 'GROUP') {
            if (element.contextValue === 'group-connected') {
                return this.data.nonScratchOrgs.map((org: any) => {
                    const label = org.alias || org.username.split('@')[0]; // Fallback to partial username if no alias
                    const context = org.isDevHub ? 'org-devhub' : 'org-connected';
                    return new OrgItem(label, vscode.TreeItemCollapsibleState.None, org, 'ORG', context);
                });
            } else if (element.contextValue === 'group-scratch') {
                return this.data.scratchOrgs.map((org: any) => {
                    const label = org.alias || "Scratch Org";
                    return new OrgItem(label, vscode.TreeItemCollapsibleState.None, org, 'ORG', 'org-scratch');
                });
            }
        }

        return [];
    }

    private async fetchOrgs() {
        try {
            const output = await runCommand('sf org list --json');
            const json = JSON.parse(output);
            if (json.status === 0) {
                this.data = json.result;
            } else {
                vscode.window.showErrorMessage("Failed to fetch orgs: " + json.message);
                this.data = { nonScratchOrgs: [], scratchOrgs: [] };
            }
        } catch (e: any) {
            vscode.window.showErrorMessage("Error listing orgs: " + e.message);
            this.data = { nonScratchOrgs: [], scratchOrgs: [] };
        }
    }
}

export const orgTreeProvider = new OrgTreeProvider();
