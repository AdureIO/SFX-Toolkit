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
    private _rootItems: OrgItem[] = [];

    constructor() {}

    refresh(): void {
        this.data = null; // Clear cache
        this._rootItems = []; // Clear root item cache
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
            
            // If roots cached, return them to maintain reference equality for reveal()
            if (this._rootItems.length > 0) {
                 return this._rootItems;
            }

            // Return Groups and cache them
            this._rootItems = [
                new OrgItem("Dev Hubs", vscode.TreeItemCollapsibleState.Expanded, null, 'GROUP', 'group-devhub'),
                new OrgItem("Production", vscode.TreeItemCollapsibleState.Expanded, null, 'GROUP', 'group-production'),
                new OrgItem("Sandboxes", vscode.TreeItemCollapsibleState.Expanded, null, 'GROUP', 'group-sandbox'),
                new OrgItem("Scratch Orgs", vscode.TreeItemCollapsibleState.Expanded, null, 'GROUP', 'group-scratch')
            ];
            return this._rootItems;
        }

        if (element.type === 'GROUP') {
            const allNonScratch = this.data.nonScratchOrgs || [];

            if (element.contextValue === 'group-devhub') {
                const orgs = allNonScratch.filter((o: any) => o.isDevHub);
                orgs.sort((a: any, b: any) => (a.alias || a.username).localeCompare(b.alias || b.username));
                return orgs.map((org: any) => new OrgItem(org.alias || org.username.split('@')[0], vscode.TreeItemCollapsibleState.None, org, 'ORG', 'org-devhub'));

            } else if (element.contextValue === 'group-production') {
                // Production = Not DevHub AND Not Sandbox
                const orgs = allNonScratch.filter((o: any) => !o.isDevHub && !o.isSandbox);
                orgs.sort((a: any, b: any) => (a.alias || a.username).localeCompare(b.alias || b.username));
                return orgs.map((org: any) => new OrgItem(org.alias || org.username.split('@')[0], vscode.TreeItemCollapsibleState.None, org, 'ORG', 'org-connected'));

            } else if (element.contextValue === 'group-sandbox') {
                // Sandbox = Not DevHub AND isSandbox
                const orgs = allNonScratch.filter((o: any) => !o.isDevHub && o.isSandbox);
                orgs.sort((a: any, b: any) => (a.alias || a.username).localeCompare(b.alias || b.username));
                return orgs.map((org: any) => new OrgItem(org.alias || org.username.split('@')[0], vscode.TreeItemCollapsibleState.None, org, 'ORG', 'org-connected'));

            } else if (element.contextValue === 'group-scratch') {
                const orgs = [...this.data.scratchOrgs];
                
                // Sort: Default > Alphabetical
                orgs.sort((a: any, b: any) => {
                    if (a.isDefaultUsername && !b.isDefaultUsername) return -1;
                    if (!a.isDefaultUsername && b.isDefaultUsername) return 1;
                    return (a.alias || a.username).localeCompare(b.alias || b.username);
                });

                return orgs.map((org: any) => {
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
    getParent(element: OrgItem): vscode.ProviderResult<OrgItem> {
        if (element.type === 'GROUP') {
            return null;
        }

        // Ensure roots are loaded
        if (this._rootItems.length === 4) {
             const [devHubs, prod, sandboxes, scratches] = this._rootItems;
             
             if (element.contextValue === 'org-scratch') {
                 return scratches;
             }
             if (element.contextValue === 'org-devhub') {
                 return devHubs;
             }
             
             // Remaining are connected orgs: either prod or sandbox
             // We can check based on orgData.isSandbox
             if (element.orgData.isSandbox) {
                 return sandboxes;
             } else {
                 return prod;
             }
        }
        return null; // Should not happen if tree is consistent
    }

    getRootItems(): OrgItem[] {
      return this._rootItems;
    }
}

export const orgTreeProvider = new OrgTreeProvider();
