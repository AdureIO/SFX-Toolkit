/**
 * Host glue for SOQL field validation: resolves the FROM object's fields from the
 * cache (no extra fetch beyond what completion already warmed) and runs the pure
 * validator. Shared by both SOQL editors so there's one implementation.
 */
import { OrgMetadataCache } from "./orgMetadataCache";
import { topLevelFromObject, validateSoqlFields, type SoqlMarker } from "./soqlValidate";

const nsless = (s: string) => s.replace(/^[a-z0-9]+__/i, "");

export async function getSoqlMarkers(org: string | null, text: string): Promise<SoqlMarker[]> {
	const obj = topLevelFromObject(text);
	if (!obj) return [];
	const fr = await OrgMetadataCache.getFieldsAndRelations(org, obj);
	if (!fr.length) return []; // unknown object or schema unavailable → don't flag anything
	const fields = new Set<string>();
	const rels = new Set<string>();
	for (const f of fr) {
		const target = f.rel ? rels : fields;
		target.add(f.name.toLowerCase());
		target.add(nsless(f.name).toLowerCase());
	}
	return validateSoqlFields(text, fields, rels);
}
