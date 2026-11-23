/**
 * Pure per-project org assignment for multi-project selections (no `vscode`, no I/O):
 * each project dir resolves to its own default org; a selection spanning several orgs
 * is described so the confirmation / progress can say so.
 */
export interface ProjectOrg {
	projectDir: string;
	username: string | null;
	displayName: string | null;
}

export interface OrgAssignment<G extends { projectDir: string }> {
	group: G;
	org: ProjectOrg;
}

/** Pair every group with the default org of its own project. */
export function assignOrgs<G extends { projectDir: string }>(
	groups: G[],
	resolve: (projectDir: string) => { username: string; displayName: string } | null
): OrgAssignment<G>[] {
	return groups.map((group) => {
		const o = resolve(group.projectDir);
		return { group, org: { projectDir: group.projectDir, username: o?.username ?? null, displayName: o?.displayName ?? null } };
	});
}

/** Label of an assigned org. */
export function orgLabelOf(org: ProjectOrg): string {
	return org.displayName ?? org.username ?? "default org";
}

/** Distinct orgs (by username, `null` = unresolved) in assignment order. */
export function distinctOrgs<G extends { projectDir: string }>(assignments: OrgAssignment<G>[]): ProjectOrg[] {
	const seen = new Set<string | null>();
	const out: ProjectOrg[] = [];
	for (const a of assignments) {
		if (seen.has(a.org.username)) continue;
		seen.add(a.org.username);
		out.push(a.org);
	}
	return out;
}

/** "Org A" for one org, "Org A, Org B" when the selection spans several. */
export function summarizeOrgs<G extends { projectDir: string }>(assignments: OrgAssignment<G>[]): string {
	return distinctOrgs(assignments).map(orgLabelOf).join(", ");
}

/** True when the selection targets more than one distinct org. */
export function spansMultipleOrgs<G extends { projectDir: string }>(assignments: OrgAssignment<G>[]): boolean {
	return distinctOrgs(assignments).length > 1;
}
