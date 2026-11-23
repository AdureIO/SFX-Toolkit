import * as assert from "assert";
import * as path from "path";
import {
	activeFirst,
	addSnippetTarget,
	effectiveFilter,
	filterSnippets,
	legacyMigrationSource,
	legacyOwnerDir,
	showProjectBadge,
	snippetsDirOf,
} from "../utils/snippetsPure";

const WS = path.resolve("/ws");
const A = path.join(WS, "a");
const B = path.join(WS, "b");

describe("snippetsPure", () => {
	it("stores snippets under the project dir", () => {
		assert.strictEqual(snippetsDirOf(A), path.join(A, ".vscode", "apex-snippets"));
	});

	describe("legacy owner", () => {
		it("is the project at the workspace folder root", () => {
			assert.strictEqual(legacyOwnerDir(WS, [A, WS, B]), WS);
		});
		it("else the first project inside the folder", () => {
			assert.strictEqual(legacyOwnerDir(WS, [A, B]), A);
		});
		it("is none without a project in the folder", () => {
			assert.strictEqual(legacyOwnerDir(WS, [path.resolve("/other/x")]), undefined);
		});
	});

	describe("legacy migration source", () => {
		const base = { workspaceFolder: WS, projectDirs: [A, B], legacyDirExists: true, projectDirHasSnippetsDir: false };
		it("copies the old folder into the first project", () => {
			assert.strictEqual(legacyMigrationSource({ ...base, projectDir: A }), path.join(WS, ".vscode", "apex-snippets"));
		});
		it("does nothing for the other projects", () => {
			assert.strictEqual(legacyMigrationSource({ ...base, projectDir: B }), undefined);
		});
		it("does nothing when the project already has snippets of its own", () => {
			assert.strictEqual(legacyMigrationSource({ ...base, projectDir: A, projectDirHasSnippetsDir: true }), undefined);
		});
		it("does nothing without an old folder", () => {
			assert.strictEqual(legacyMigrationSource({ ...base, projectDir: A, legacyDirExists: false }), undefined);
		});
		it("does nothing for a project at the workspace root (same location)", () => {
			assert.strictEqual(legacyMigrationSource({ ...base, projectDirs: [WS, A], projectDir: WS }), undefined);
			assert.strictEqual(legacyMigrationSource({ ...base, projectDirs: [WS, A], projectDir: A }), undefined);
		});
	});

	describe("filter", () => {
		const snippets = [
			{ name: "x", projectDir: A },
			{ name: "y", projectDir: B },
			{ name: "z", projectDir: A },
		];
		it("all keeps every snippet", () => {
			assert.deepStrictEqual(filterSnippets(snippets, "all").map((s) => s.name), ["x", "y", "z"]);
		});
		it("a project keeps its own snippets only", () => {
			assert.deepStrictEqual(filterSnippets(snippets, B).map((s) => s.name), ["y"]);
		});
		it("falls back to all when the stored project vanished", () => {
			assert.strictEqual(effectiveFilter(path.join(WS, "gone"), [A, B]), "all");
			assert.strictEqual(effectiveFilter(undefined, [A, B]), "all");
			assert.strictEqual(effectiveFilter(B, [A, B]), B);
		});
	});

	it("shows the project badge only with several projects", () => {
		assert.strictEqual(showProjectBadge(1), false);
		assert.strictEqual(showProjectBadge(2), true);
	});

	describe("add target", () => {
		it("is the filtered project", () => {
			assert.deepStrictEqual(addSnippetTarget(B, [A, B]), { kind: "dir", dir: B });
		});
		it("is the only project", () => {
			assert.deepStrictEqual(addSnippetTarget("all", [A]), { kind: "dir", dir: A });
		});
		it("asks with several projects and the filter on all", () => {
			assert.deepStrictEqual(addSnippetTarget("all", [A, B]), { kind: "ask" });
		});
		it("is none without projects", () => {
			assert.deepStrictEqual(addSnippetTarget("all", []), { kind: "none" });
		});
	});

	it("puts the active project first", () => {
		assert.deepStrictEqual(activeFirst([A, B], B), [B, A]);
		assert.deepStrictEqual(activeFirst([A, B], undefined), [A, B]);
	});
});
