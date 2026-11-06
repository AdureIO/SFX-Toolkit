/**
 * Setup page paths (for `sf org open --path`) of metadata components. Pure.
 */

export interface SetupTarget {
	/** Path relative to the org's domain. */
	path: string;
	/** True when the path only reaches a list page: the caller should copy the name for Quick Find. */
	quickFind: boolean;
}

const HOME = "/lightning/setup/SetupOneHome/home";

/** Setup list pages for types without a per-record URL. */
const LIST_PAGES: Record<string, string> = {
	ApexClass: "ApexClasses",
	ApexTrigger: "ApexTriggers",
	ApexPage: "ApexPages",
	ApexComponent: "ApexComponents",
	CustomObject: "ObjectManager",
	Flow: "Flows",
	LightningComponentBundle: "LightningComponentBundles",
	AuraDefinitionBundle: "LightningComponentBundles",
	PermissionSet: "PermSets",
	PermissionSetGroup: "PermSetGroups",
	Profile: "EnhancedProfiles",
	CustomLabels: "ExternalStrings",
	CustomTab: "CustomTabs",
	CustomApplication: "AppMenu",
	StaticResource: "StaticResources",
	NamedCredential: "NamedCredential",
	ConnectedApp: "ConnectedApplication",
	RemoteSiteSetting: "SecurityRemoteProxy",
	Role: "Roles",
	Group: "PublicGroups",
	Queue: "Queues",
	EmailTemplate: "CommunicationTemplatesEmail",
	CustomMetadata: "CustomMetadata",
	ReportType: "CustomReportTypes",
	FlexiPage: "FlexiPageList",
	ValidationRule: "ObjectManager",
	QuickAction: "GlobalActions",
};

const encodeAddress = (id: string) => `%2F${id}`;

/** Where to send the user for a component. `id` is the Salesforce Id from listMetadata when known. */
export function setupTarget(type: string, fullName: string, id: string): SetupTarget {
	const sid = /^[A-Za-z0-9]{15,18}$/.test(id) ? id : "";
	const obj = fullName.split(".")[0];
	switch (type) {
		case "ApexClass":
			return sid ? { path: `/lightning/setup/ApexClasses/page?address=${encodeAddress(sid)}`, quickFind: false } : listPage(type);
		case "ApexTrigger":
			return sid ? { path: `/${sid}`, quickFind: false } : listPage(type);
		case "CustomObject":
			return { path: `/lightning/setup/ObjectManager/${encodeURIComponent(fullName)}/Details/view`, quickFind: false };
		case "CustomField":
			return {
				path: sid
					? `/lightning/setup/ObjectManager/${encodeURIComponent(obj)}/FieldsAndRelationships/${sid}/view`
					: `/lightning/setup/ObjectManager/${encodeURIComponent(obj)}/FieldsAndRelationships/view`,
				quickFind: !sid,
			};
		case "Flow":
			return sid && sid.startsWith("301")
				? { path: `/builder_platform_interaction/flowBuilder.app?flowId=${sid}`, quickFind: false }
				: listPage(type);
		case "PermissionSet":
			return sid ? { path: `/lightning/setup/PermSets/page?address=${encodeAddress(sid)}`, quickFind: false } : listPage(type);
		case "Profile":
			return sid ? { path: `/lightning/setup/EnhancedProfiles/page?address=${encodeAddress(sid)}`, quickFind: false } : listPage(type);
		case "Layout": {
			const layoutObj = fullName.split("-")[0];
			return sid && layoutObj
				? { path: `/lightning/setup/ObjectManager/${encodeURIComponent(layoutObj)}/PageLayouts/${sid}/view`, quickFind: false }
				: { path: layoutObj ? `/lightning/setup/ObjectManager/${encodeURIComponent(layoutObj)}/PageLayouts/view` : HOME, quickFind: true };
		}
		case "LightningComponentBundle":
		case "AuraDefinitionBundle":
			return listPage(type);
		default: {
			// Child types of an object (ValidationRule, RecordType, ListView …) live under the object.
			if (/^(ValidationRule|RecordType|WebLink|CompactLayout|FieldSet|BusinessProcess|SharingReason|ListView)$/.test(type) && fullName.includes(".")) {
				const section: Record<string, string> = {
					ValidationRule: "ValidationRules",
					RecordType: "RecordTypes",
					WebLink: "ButtonsLinksActions",
					CompactLayout: "CompactLayouts",
					FieldSet: "FieldSets",
					BusinessProcess: "BusinessProcesses",
					SharingReason: "SharingReasons",
					ListView: "ListViewsAndSearchLayouts",
				};
				return { path: `/lightning/setup/ObjectManager/${encodeURIComponent(obj)}/${section[type]}/view`, quickFind: true };
			}
			return listPage(type);
		}
	}
}

function listPage(type: string): SetupTarget {
	const page = LIST_PAGES[type];
	return page ? { path: `/lightning/setup/${page}/home`, quickFind: true } : { path: HOME, quickFind: true };
}
