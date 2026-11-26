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

/**
 * Org Browser row status codes (index into `STATUS_NAMES`). 0..4 are shared with the Deploy panel
 * (see compareStatusPure): absent on the other side, equal, changed locally, changed in org, conflict.
 */
export const STATUS_NOT_IN_PROJECT = 0;
export const STATUS_EQUAL = 1;
export const STATUS_CHANGED_LOCALLY = 2;
export const STATUS_CHANGED_IN_ORG = 3;
export const STATUS_CONFLICT = 4;
/** CustomObject whose object file is missing locally but some of its children (fields …) exist. */
export const STATUS_PARTIAL = 5;
/** The local project was not read yet (or its change info is not available yet). */
export const STATUS_UNKNOWN = 6;
export const STATUS_NAMES = ["not-in-project", "equal", "changed-locally", "changed-in-org", "conflict", "partial", "unknown"] as const;
/** `Type:Name` row key used across host, webview, local index and retrieve log. */
export function compKey(type: string, fullName: string): string {
	return `${type}:${fullName}`;
}
