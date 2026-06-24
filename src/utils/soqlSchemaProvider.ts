/**
 * Host-side schema provider for the SOQL language server.
 *
 * The language server (out/server.js) asks the extension host for object lists
 * and describes via custom LSP requests; this module answers them. It reuses
 * AuthInfo (authenticated REST + 401 retry) and returns exactly the field shape
 * the server needs to expand SOQL completion placeholders — including the flags
 * (sortable/aggregatable/groupable/nillable) and picklist values that the lighter
 * OrgMetadataCache / SchemaCache do not capture.
 */
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";
import { OrgMetadataCache } from "./orgMetadataCache";

export interface SoqlHostField {
	name: string;
	type: string;
	label?: string;
	helpText?: string;
	length?: number;
	sortable?: boolean;
	aggregatable?: boolean;
	groupable?: boolean;
	nillable?: boolean;
	relationshipName?: string;
	referenceTo?: string[];
	picklistValues?: string[];
}

export interface SoqlHostChildRelationship {
	name: string;
	childSObject: string;
}

export interface SoqlHostDescribe {
	name?: string;
	label?: string;
	labelPlural?: string;
	keyPrefix?: string;
	custom?: boolean;
	queryable?: boolean;
	createable?: boolean;
	updateable?: boolean;
	deletable?: boolean;
	fields: SoqlHostField[];
	childRelationships: SoqlHostChildRelationship[];
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_KEY_DEFAULT = "__default__";

interface Entry {
	describe: SoqlHostDescribe;
	fetchedAt: number;
}

class SoqlSchemaProviderImpl {
	private cache = new Map<string, Map<string, Entry>>();
	/** org+sobject → admin description (null = none). */
	private descriptionCache = new Map<string, string | null>();
	/** orgs where EntityDefinition.Description isn't queryable — stop retrying. */
	private descriptionUnavailable = new Set<string>();

	private orgMap(org: string | null): Map<string, Entry> {
		const key = org || CACHE_KEY_DEFAULT;
		let m = this.cache.get(key);
		if (!m) {
			m = new Map();
			this.cache.set(key, m);
		}
		return m;
	}

	/** SObject names for completion (delegates to the shared lightweight cache). */
	async getObjectList(org: string | null): Promise<string[]> {
		return OrgMetadataCache.getObjectList(org);
	}

	/**
	 * Admin Description of an SObject (not present in the standard describe) via the
	 * Tooling API EntityDefinition. Cached; self-disables per org if not queryable.
	 */
	async getObjectDescription(org: string | null, sobject: string): Promise<string | null> {
		if (!sobject) return null;
		const orgKeyStr = org || CACHE_KEY_DEFAULT;
		if (this.descriptionUnavailable.has(orgKeyStr)) return null;
		const key = `${orgKeyStr}|${sobject}`;
		if (this.descriptionCache.has(key)) return this.descriptionCache.get(key) ?? null;

		const version = getToolingApiVersion();
		const soql = `SELECT Description FROM EntityDefinition WHERE QualifiedApiName='${sobject.replace(/'/g, "")}'`;
		try {
			const { body } = await AuthInfo.get(org, (a) =>
				`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/tooling/query/?q=${encodeURIComponent(soql)}`
			);
			const data = JSON.parse(body);
			const desc = (data.records && data.records[0] && data.records[0].Description) || null;
			this.descriptionCache.set(key, desc);
			return desc;
		} catch (e: any) {
			// Likely INVALID_FIELD on this org/version — stop retrying to avoid noise.
			this.descriptionUnavailable.add(orgKeyStr);
			outputChannel.appendLine(`SoqlSchemaProvider: object description unavailable (${sobject}): ${e?.message ?? e}`);
			return null;
		}
	}

	/** Server-shaped describe for a single sobject (cached, 15-min TTL). */
	async getDescribe(org: string | null, sobject: string): Promise<SoqlHostDescribe | null> {
		if (!sobject) return null;
		const map = this.orgMap(org);
		const hit = map.get(sobject);
		if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.describe;

		const version = getToolingApiVersion();
		try {
			const { body } = await AuthInfo.get(org, (a) =>
				`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/sobjects/${encodeURIComponent(sobject)}/describe`
			);
			const raw = JSON.parse(body);
			const describe = this.parse(raw);
			map.set(sobject, { describe, fetchedAt: Date.now() });
			return describe;
		} catch (e: any) {
			outputChannel.appendLine(`SoqlSchemaProvider: describe ${sobject} failed: ${e?.message ?? e}`);
			return null;
		}
	}

	private parse(raw: any): SoqlHostDescribe {
		const fields: SoqlHostField[] = Array.isArray(raw.fields)
			? raw.fields.map((f: any) => {
					const out: SoqlHostField = {
						name: f.name,
						type: f.type || "string",
						sortable: f.sortable,
						aggregatable: f.aggregatable,
						groupable: f.groupable,
						nillable: f.nillable,
					};
					if (f.label) out.label = f.label;
					if (f.inlineHelpText) out.helpText = f.inlineHelpText;
					if (typeof f.length === "number" && f.length > 0) out.length = f.length;
					if (f.relationshipName) out.relationshipName = f.relationshipName;
					if (Array.isArray(f.referenceTo) && f.referenceTo.length) out.referenceTo = f.referenceTo;
					if (Array.isArray(f.picklistValues) && f.picklistValues.length) {
						out.picklistValues = f.picklistValues
							.filter((p: any) => p && p.active !== false && p.value)
							.map((p: any) => p.value as string);
					}
					return out;
				})
			: [];

		const childRelationships: SoqlHostChildRelationship[] = Array.isArray(raw.childRelationships)
			? raw.childRelationships
					.filter((cr: any) => cr && cr.relationshipName && cr.childSObject && !cr.deprecatedAndHidden)
					.map((cr: any) => ({ name: cr.relationshipName as string, childSObject: cr.childSObject as string }))
			: [];

		return {
			name: raw.name,
			label: raw.label,
			labelPlural: raw.labelPlural,
			keyPrefix: raw.keyPrefix || undefined,
			custom: raw.custom,
			queryable: raw.queryable,
			createable: raw.createable,
			updateable: raw.updateable,
			deletable: raw.deletable,
			fields,
			childRelationships,
		};
	}

	invalidate(org: string | null): void {
		this.cache.delete(org || CACHE_KEY_DEFAULT);
	}

	invalidateAll(): void {
		this.cache.clear();
		this.descriptionCache.clear();
		this.descriptionUnavailable.clear();
	}
}

export const SoqlSchemaProvider = new SoqlSchemaProviderImpl();
