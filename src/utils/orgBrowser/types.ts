/**
 * Shared Org Browser types. Pure (no `vscode`): used by the extension host, the unit tests and the
 * webview bundle. Component fields use short keys — a full org is 50k+ rows that cross the
 * host/webview boundary and sit in the disk cache.
 */

/** One metadata component of an org (a row in the browser). */
export interface Comp {
	/** Metadata type (xmlName), e.g. `ApexClass`, `CustomField`. */
	t: string;
	/** fullName, e.g. `MyClass`, `Account.Foo__c`, `Folder/Report`. */
	n: string;
	/** Namespace prefix ("" = unmanaged / local). */
	ns: string;
	/** manageableState: unmanaged | installed | released | beta | deleted | deprecated | installedEditable | deprecatedEditable ("" if unknown). */
	ms: string;
	/** lastModifiedByName. */
	by: string;
	/** lastModifiedById. */
	bi: string;
	/** lastModifiedDate, epoch ms (0 = unknown). */
	lm: number;
	/** createdDate, epoch ms (0 = unknown). */
	cd: number;
	/** Salesforce Id when the API returned one. */
	id: string;
	/** fileName, e.g. `classes/MyClass.cls`. */
	f: string;
}

/** A metadata type of the org, from describeMetadata (parents) or its childXmlNames. */
export interface TypeInfo {
	name: string;
	/** Source directory name (`classes`); "" for child types. */
	dir: string;
	/** File suffix (`cls`); "" if none. */
	suffix: string;
	inFolder: boolean;
	metaFile: boolean;
	/** Child xml names of a parent type. */
	children: string[];
	/** Set on child types: the parent that declared them. */
	parent?: string;
}

/** A type (or folder query) that could not be listed. */
export interface ListFailure {
	type: string;
	error: string;
}

/** Local status codes (index into `STATUS_NAMES`). */
export const STATUS_NOT_LOCAL = 0;
export const STATUS_LOCAL = 1;
export const STATUS_CHANGED = 2;
export type StatusCode = 0 | 1 | 2;
export const STATUS_NAMES = ["not-local", "local", "changed"] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

/** `Type:Name` row key used across host, webview, local index and retrieve log. */
export function compKey(type: string, fullName: string): string {
	return `${type}:${fullName}`;
}
