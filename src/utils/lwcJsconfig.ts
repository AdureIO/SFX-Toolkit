/**
 * Build the `jsconfig.json` an LWC folder needs for IntelliSense to work across files.
 *
 * Most "IntelliSense doesn't work in LWC" symptoms trace back to this single file:
 *   • `c/*` cross-component imports don't resolve without the `paths` mapping.
 *   • Relative imports into a component's own SUBDIRECTORIES (`./utils/helper`) only resolve when
 *     the folder is in `include` and module resolution is set up.
 *   • The generated `@salesforce/...` typings are only picked up via the `include` entry.
 *   • Decorators (`@api`, `@track`, `@wire`) error without `experimentalDecorators`.
 *
 * Pure + testable: this module only computes the desired JSON and merges it with whatever is
 * already there, preserving keys we don't own.
 */

export interface JsconfigShape {
    compilerOptions?: Record<string, unknown>;
    include?: string[];
    exclude?: string[];
    [key: string]: unknown;
}

/** Compiler options we require for LWC. Existing values are kept unless they're wrong for LWC. */
const REQUIRED_COMPILER_OPTIONS: Record<string, unknown> = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "node",
    // `@api` / `@track` / `@wire` are decorators.
    experimentalDecorators: true,
    // Resolve `c/*` and relative paths from the lwc folder itself.
    baseUrl: ".",
    allowJs: true,
    checkJs: false
};

/** `c/foo` lives at `foo/foo.js`, so the mapping must be `*/ /*` — plus `*` for flat layouts. */
const REQUIRED_PATHS: Record<string, string[]> = {
    "c/*": ["*/*", "*"]
};

/** Include the component sources AND the generated Salesforce typings. */
export function requiredIncludes(typingsRelativePath: string): string[] {
    return ["**/*", `${typingsRelativePath}/**/*.d.ts`];
}

function uniq(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

/**
 * Merge the required LWC settings into an existing jsconfig (or an empty one).
 * Anything the user set that we don't require is preserved.
 *
 * @param existing        the parsed current jsconfig, or undefined when the file is missing
 * @param typingsRelPath  relative path from the lwc folder to `.sfdx/typings/lwc`
 */
export function buildLwcJsconfig(existing: JsconfigShape | undefined, typingsRelPath: string): JsconfigShape {
    const base: JsconfigShape = existing ? { ...existing } : {};
    const compilerOptions: Record<string, unknown> = { ...(base.compilerOptions ?? {}) };

    for (const [key, value] of Object.entries(REQUIRED_COMPILER_OPTIONS)) {
        // Only fill in what's missing — except the ones that actively break LWC if wrong.
        const mustOverride = key === "experimentalDecorators" || key === "baseUrl" || key === "moduleResolution";
        if (mustOverride || compilerOptions[key] === undefined) compilerOptions[key] = value;
    }

    const paths: Record<string, string[]> = { ...((compilerOptions.paths as Record<string, string[]>) ?? {}) };
    for (const [key, value] of Object.entries(REQUIRED_PATHS)) {
        paths[key] = uniq([...(paths[key] ?? []), ...value]);
    }
    compilerOptions.paths = paths;

    return {
        ...base,
        compilerOptions,
        include: uniq([...(base.include ?? []), ...requiredIncludes(typingsRelPath)])
    };
}

/** True when the current jsconfig already has everything we need (so we can skip writing). */
export function jsconfigNeedsUpdate(existing: JsconfigShape | undefined, typingsRelPath: string): boolean {
    if (!existing) return true;
    return JSON.stringify(buildLwcJsconfig(existing, typingsRelPath)) !== JSON.stringify(existing);
}
