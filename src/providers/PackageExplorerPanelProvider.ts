import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { runCommandArgs } from "../utils/commandRunner";
import { Telemetry, categorizeError } from "../utils/telemetry";

/** A Dev Hub org that can own 2GP packages. */
interface HubOption {
  username: string;
  alias?: string;
  isDefault: boolean;
}

/** Any authorized org (target for install / uninstall). */
interface OrgOption {
  username: string;
  alias?: string;
  scratch: boolean;
}

/** One package version (Package2Version) flattened for the webview. */
interface PackageVersion {
  versionId: string; // 05i...
  subscriberPackageVersionId: string; // 04t...
  version: string; // 1.2.3.4
  name?: string;
  released: boolean;
  passwordProtected: boolean;
  branch?: string;
  tag?: string;
  createdDate?: string;
  coverage?: string; // "85%"
  passedCoverage?: boolean;
  ancestorVersion?: string;
  alias?: string; // from sfdx-project.json packageAliases
}

/** A declared dependency from sfdx-project.json, resolved against packageAliases. */
interface PkgDependency {
  label: string; // alias/ref as written
  versionNumber?: string;
  id?: string; // resolved 04t / 0Ho
}

interface SfdxPackageDir {
  package?: string;
  dependencies?: { package?: string; versionNumber?: string }[];
}

/** One package (Package2) with its versions. */
interface PackageEntry {
  id: string; // 0Ho...
  subscriberPackageId?: string; // 033...
  name: string;
  namespace?: string;
  type?: string; // Managed | Unlocked
  isOrgDependent?: boolean;
  alias?: string;
  dependencies?: PkgDependency[];
  versions: PackageVersion[];
}

/** A package installed in a target org (subscriber view). */
interface InstalledPackage {
  name: string;
  namespace?: string;
  version: string;
  subscriberPackageVersionId: string; // 04t...
  subscriberPackageId?: string; // 033...
  upgradeVersion?: string; // latest released in hub, if newer
  upgradeId?: string; // its 04t
}

const LONG_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Package Explorer — Dev Hub 2GP control panel.
 *
 * Read: `sf package list` + `sf package version list --verbose` against a hub,
 * plus `sf package installed list` for the "installed in org" mode. Package
 * aliases are pulled from sfdx-project.json.
 *
 * Write (native confirm + progress): install, uninstall, promote, delete
 * version/package, update version, rename package, create package. Version
 * report surfaces dependencies and ancestry.
 */
export class PackageExplorerPanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.packageExplorer";
  private static _panel: vscode.WebviewPanel | undefined;
  private static _selectedHub: string | undefined;
  private static _installedOrg: string | undefined;
  /** `--verbose` on version list computes coverage per version — slow on large packages; off by default. */
  private static _verbose = false;
  /** Cached Dev Hub list and per-hub packages, so reopening/switching is instant. Refresh forces a reload. */
  private static _hubCache: HubOption[] | undefined;
  private static readonly _packageCache = new Map<string, PackageEntry[]>();

  /** @param hubUsername when launched from a Dev Hub org node, preselect that hub. */
  public static async show(hubUsername?: string): Promise<void> {
    if (hubUsername) PackageExplorerPanelProvider._selectedHub = hubUsername;
    this.ensurePanel();
    await this.load();
  }

  /** Open directly on the "Installed in org" view for a specific org (any org, not just hubs). */
  public static async showInstalled(username: string): Promise<void> {
    PackageExplorerPanelProvider._installedOrg = username;
    this.ensurePanel();
    await this.loadInstalled();
  }

  private static ensurePanel(): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (PackageExplorerPanelProvider._panel) {
      PackageExplorerPanelProvider._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PackageExplorerPanelProvider.viewType,
      "Package Explorer (Dev Hub)",
      column,
      { enableScripts: true }
    );
    PackageExplorerPanelProvider._panel = panel;
    panel.webview.html = this.getHtml();
    const messageListener = panel.webview.onDidReceiveMessage((msg: { command: string; [k: string]: unknown }) =>
      this.handleMessage(msg)
    );
    panel.onDidDispose(() => {
      messageListener.dispose();
      PackageExplorerPanelProvider._panel = undefined;
    });
  }

  // ── Message routing ─────────────────────────────────────────────────────────

  private static async handleMessage(msg: { command: string; [k: string]: unknown }): Promise<void> {
    const s = (k: string): string | undefined => (typeof msg[k] === "string" ? (msg[k] as string) : undefined);
    switch (msg.command) {
      case "refresh":
        await this.load(true);
        break;
      case "selectHub":
        PackageExplorerPanelProvider._selectedHub = s("hub");
        await this.load(false);
        break;
      case "setMode":
        if (s("mode") === "installed") await this.loadInstalled();
        else await this.load(false);
        break;
      case "setVerbose":
        PackageExplorerPanelProvider._verbose = s("on") === "1";
        await this.reloadHub();
        break;
      case "pickInstalledOrg":
        await this.loadInstalled(true);
        break;
      case "copy":
        if (s("text")) {
          await vscode.env.clipboard.writeText(s("text") as string);
          vscode.window.setStatusBarMessage(`Copied: ${this.truncate(s("text") as string, 60)}`, 2500);
        }
        break;
      case "install":
        await this.installVersion(s("id"), s("name"), s("protected") === "1");
        break;
      case "upgrade":
        await this.installVersion(s("id"), s("name"), false, PackageExplorerPanelProvider._installedOrg);
        break;
      case "uninstall":
        await this.uninstallVersion(s("id"), s("name"));
        break;
      case "promote":
        await this.promoteVersion(s("id"), s("version"));
        break;
      case "deleteVersion":
        await this.deleteVersion(s("id"), s("version"));
        break;
      case "updateVersion":
        await this.updateVersion(s("id"), s("version"));
        break;
      case "updatePackage":
        await this.updatePackage(s("pkgId"), s("name"));
        break;
      case "report":
        await this.versionReport(s("id"));
        break;
      case "exportMd":
        await this.exportCurrent(s("pkgId"), "md");
        break;
      case "exportCsv":
        await this.exportCurrent(s("pkgId"), "csv");
        break;
    }
  }

  // ── Hub-mode load ───────────────────────────────────────────────────────────

  private static async load(force = false): Promise<void> {
    const panel = PackageExplorerPanelProvider._panel;
    if (!panel) return;
    try {
      const hubs = await this.getDevHubs(force);
      if (hubs.length === 0) {
        panel.webview.postMessage({
          command: "setError",
          message:
            "No Dev Hub found. Authorize a Dev Hub org (Enable Dev Hub in Setup, then connect it) and set it as your default Dev Hub."
        });
        Telemetry.event("packageExplorer", { status: "no-devhub" });
        return;
      }

      let selected = PackageExplorerPanelProvider._selectedHub;
      if (!selected || !hubs.some((h) => h.username === selected)) {
        selected = (hubs.find((h) => h.isDefault) ?? hubs[0]).username;
        PackageExplorerPanelProvider._selectedHub = selected;
      }
      panel.webview.postMessage({ command: "setHubs", hubs, selected });

      const showLoading = force || !PackageExplorerPanelProvider._packageCache.has(selected);
      if (showLoading) panel.webview.postMessage({ command: "setLoading", loading: true });
      try {
        const packages = await this.getPackages(selected, force);
        panel.webview.postMessage({ command: "setPackages", packages });
        if (showLoading) {
          Telemetry.event(
            "packageExplorer",
            { status: "loaded" },
            { packages: packages.length, versions: packages.reduce((n, p) => n + p.versions.length, 0) }
          );
        }
      } finally {
        if (showLoading) panel.webview.postMessage({ command: "setLoading", loading: false });
      }
    } catch (error) {
      panel.webview.postMessage({ command: "setError", message: this.errorText(error) });
      Telemetry.error("packageExplorerError", { reason: categorizeError(error) });
    }
  }

  private static async getDevHubs(force = false): Promise<HubOption[]> {
    if (!force && PackageExplorerPanelProvider._hubCache) return PackageExplorerPanelProvider._hubCache;
    const raw = await runCommandArgs("sf", ["org", "list", "--json"], undefined, undefined, false);
    const parsed = JSON.parse(raw) as {
      result?: {
        nonScratchOrgs?: {
          username?: string;
          alias?: string;
          isDevHub?: boolean;
          isDefaultDevHubUsername?: boolean;
        }[];
      };
    };
    const orgs = parsed.result?.nonScratchOrgs ?? [];
    const hubs = orgs
      .filter((o) => o.isDevHub && o.username)
      .map((o) => ({ username: o.username as string, alias: o.alias, isDefault: !!o.isDefaultDevHubUsername }));
    PackageExplorerPanelProvider._hubCache = hubs;
    return hubs;
  }

  private static async getPackages(hub: string, force = false): Promise<PackageEntry[]> {
    if (!force) {
      const cached = PackageExplorerPanelProvider._packageCache.get(hub);
      if (cached) return cached;
    }
    const project = this.readProject();
    const aliases = project.idToAlias; // id -> alias
    // `--verbose` computes code coverage per version — very slow on packages with many
    // versions — so it is opt-in. Coverage is otherwise available on demand via the report.
    const verArgs = ["package", "version", "list", "--target-dev-hub", hub];
    if (PackageExplorerPanelProvider._verbose) verArgs.push("--verbose");
    verArgs.push("--json");
    const [pkgRaw, verRaw] = await Promise.all([
      runCommandArgs("sf", ["package", "list", "--target-dev-hub", hub, "--json"], undefined, undefined, false),
      runCommandArgs("sf", verArgs, undefined, undefined, false)
    ]);

    const pkgResult = (JSON.parse(pkgRaw) as { result?: Record<string, unknown>[] }).result ?? [];
    const verResult = (JSON.parse(verRaw) as { result?: Record<string, unknown>[] }).result ?? [];

    const packages: PackageEntry[] = pkgResult.map((p) => ({
      id: String(p.Id ?? ""),
      subscriberPackageId: p.SubscriberPackageId ? String(p.SubscriberPackageId) : undefined,
      name: String(p.Name ?? "(unnamed)"),
      namespace: this.str(p.Namespace ?? p.NamespacePrefix),
      type: this.str(p.Type ?? p.ContainerOptions),
      isOrgDependent: this.asBool(p.IsOrgDependent),
      alias: aliases.get(String(p.Id ?? "")),
      versions: []
    }));

    const byId = new Map(packages.map((p) => [p.id, p]));
    const byName = new Map(packages.map((p) => [p.name, p]));

    for (const v of verResult) {
      const subId = String(v.SubscriberPackageVersionId ?? "");
      const version: PackageVersion = {
        versionId: String(v.Id ?? ""),
        subscriberPackageVersionId: subId,
        version: this.versionString(v),
        name: this.str(v.Name),
        released: this.asBool(v.IsReleased) ?? false,
        passwordProtected: this.asBool(v.IsPasswordProtected) ?? false,
        branch: this.str(v.Branch),
        tag: this.str(v.Tag),
        createdDate: this.str(v.CreatedDate),
        coverage: this.coverageString(v.CodeCoverage),
        passedCoverage: this.asBool(v.HasPassedCodeCoverageCheck),
        ancestorVersion: this.str(v.AncestorVersion),
        alias: aliases.get(subId)
      };
      const target = byId.get(String(v.Package2Id ?? "")) ?? byName.get(String(v.Package2Name ?? ""));
      if (target) target.versions.push(version);
    }

    for (const p of packages) {
      p.versions.sort((a, b) => (a.createdDate ?? "").localeCompare(b.createdDate ?? "")).reverse();
    }
    packages.sort((a, b) => a.name.localeCompare(b.name));
    for (const p of packages) {
      const dir = project.dirs.find((d) => d.package && (d.package === p.alias || d.package === p.name));
      if (dir && Array.isArray(dir.dependencies)) {
        p.dependencies = dir.dependencies.map((d) => this.resolveDep(d, project.aliasToId));
      }
    }
    PackageExplorerPanelProvider._packageCache.set(hub, packages);
    return packages;
  }

  /** Parse sfdx-project.json: alias<->id maps plus packageDirectories (for declared dependencies). */
  private static readProject(): { idToAlias: Map<string, string>; aliasToId: Map<string, string>; dirs: SfdxPackageDir[] } {
    const idToAlias = new Map<string, string>();
    const aliasToId = new Map<string, string>();
    let dirs: SfdxPackageDir[] = [];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return { idToAlias, aliasToId, dirs };
    try {
      const json = JSON.parse(fs.readFileSync(path.join(root, "sfdx-project.json"), "utf8")) as {
        packageAliases?: Record<string, string>;
        packageDirectories?: SfdxPackageDir[];
      };
      for (const [alias, id] of Object.entries(json.packageAliases ?? {})) {
        if (!id) continue;
        aliasToId.set(alias, id);
        if (!idToAlias.has(id)) idToAlias.set(id, alias);
      }
      dirs = json.packageDirectories ?? [];
    } catch {
      /* no project file / not readable */
    }
    return { idToAlias, aliasToId, dirs };
  }

  /** Resolve a dependency entry's alias/ref to a concrete 04t/0Ho id when possible. */
  private static resolveDep(dep: { package?: string; versionNumber?: string }, aliasToId: Map<string, string>): PkgDependency {
    const ref = dep.package ?? "";
    let id = aliasToId.get(ref);
    if (!id && ref.includes("@")) id = aliasToId.get(ref.split("@")[0]);
    if (!id && /^04t/i.test(ref)) id = ref;
    return { label: ref, versionNumber: dep.versionNumber, id };
  }

  // ── Installed-in-org mode ───────────────────────────────────────────────────

  private static async loadInstalled(pick = false): Promise<void> {
    const panel = PackageExplorerPanelProvider._panel;
    if (!panel) return;
    try {
      let org = PackageExplorerPanelProvider._installedOrg;
      if (pick || !org) {
        const chosen = await this.pickOrg("Select an org to list installed packages");
        if (!chosen) {
          panel.webview.postMessage({ command: "setMode", mode: "hub" });
          return;
        }
        org = chosen.username;
        PackageExplorerPanelProvider._installedOrg = org;
      }
      panel.webview.postMessage({ command: "setLoading", loading: true });
      try {
        const installed = await this.getInstalled(org);
        panel.webview.postMessage({ command: "setInstalled", org, packages: installed });
        Telemetry.event("packageExplorer", { status: "installed" }, { packages: installed.length });
      } finally {
        panel.webview.postMessage({ command: "setLoading", loading: false });
      }
    } catch (error) {
      panel.webview.postMessage({ command: "setError", message: this.errorText(error) });
      Telemetry.error("packageExplorerError", { reason: categorizeError(error) });
    }
  }

  private static async getInstalled(org: string): Promise<InstalledPackage[]> {
    const raw = await runCommandArgs(
      "sf",
      ["package", "installed", "list", "--target-org", org, "--json"],
      undefined,
      undefined,
      false
    );
    const rows = (JSON.parse(raw) as { result?: Record<string, unknown>[] }).result ?? [];

    // Latest released version per subscriber-package (033), from the current hub cache, for upgrade hints.
    const hubPkgs = PackageExplorerPanelProvider._packageCache.get(PackageExplorerPanelProvider._selectedHub ?? "") ?? [];
    const latestBySubId = new Map<string, PackageVersion>();
    for (const p of hubPkgs) {
      if (!p.subscriberPackageId) continue;
      const released = p.versions.find((v) => v.released) ?? p.versions[0];
      if (released) latestBySubId.set(p.subscriberPackageId, released);
    }

    return rows.map((r) => {
      const subId = this.str(r.SubscriberPackageId);
      const currentVersionId = String(r.SubscriberPackageVersionId ?? "");
      const currentVersion = String(r.SubscriberPackageVersionNumber ?? "");
      const latest = subId ? latestBySubId.get(subId) : undefined;
      const hasUpgrade =
        latest && latest.subscriberPackageVersionId !== currentVersionId && this.versionGt(latest.version, currentVersion);
      return {
        name: String(r.SubscriberPackageName ?? "(unnamed)"),
        namespace: this.str(r.SubscriberPackageNamespace),
        version: currentVersion,
        subscriberPackageVersionId: currentVersionId,
        subscriberPackageId: subId,
        upgradeVersion: hasUpgrade ? latest!.version : undefined,
        upgradeId: hasUpgrade ? latest!.subscriberPackageVersionId : undefined
      };
    });
  }

  // ── Write actions ───────────────────────────────────────────────────────────

  private static async installVersion(id?: string, name?: string, isProtected = false, orgOverride?: string): Promise<void> {
    if (!id) return;
    let org = orgOverride;
    if (!org) {
      const chosen = await this.pickOrg(`Install ${name ?? id} into which org?`);
      if (!chosen) return;
      org = chosen.username;
    }
    const args = ["package", "install", "--package", id, "--target-org", org, "--wait", "10", "--no-prompt"];
    if (isProtected) {
      const key = await vscode.window.showInputBox({ prompt: "Installation key (password-protected package)", password: true });
      if (key) args.push("--installation-key", key);
    }
    await this.runAction(`Installing ${name ?? id} → ${org}`, args, "install");
    if (PackageExplorerPanelProvider._installedOrg === org) await this.loadInstalled();
  }

  private static async uninstallVersion(id?: string, name?: string): Promise<void> {
    if (!id) return;
    const org = PackageExplorerPanelProvider._installedOrg;
    if (!org) return;
    const ok = await vscode.window.showWarningMessage(`Uninstall ${name ?? id} from ${org}?`, { modal: true }, "Uninstall");
    if (ok !== "Uninstall") return;
    await this.runAction(
      `Uninstalling ${name ?? id} from ${org}`,
      ["package", "uninstall", "--package", id, "--target-org", org, "--wait", "10"],
      "uninstall"
    );
    await this.loadInstalled();
  }

  private static async promoteVersion(id?: string, version?: string): Promise<void> {
    if (!id) return;
    const hub = PackageExplorerPanelProvider._selectedHub;
    if (!hub) return;
    const ok = await vscode.window.showWarningMessage(
      `Promote ${version ?? id} to released? This cannot be undone.`,
      { modal: true },
      "Promote"
    );
    if (ok !== "Promote") return;
    await this.runAction(
      `Promoting ${version ?? id}`,
      ["package", "version", "promote", "--package", id, "--target-dev-hub", hub, "--no-prompt"],
      "promote"
    );
    await this.reloadHub();
  }

  private static async deleteVersion(id?: string, version?: string): Promise<void> {
    if (!id) return;
    const hub = PackageExplorerPanelProvider._selectedHub;
    if (!hub) return;
    const ok = await vscode.window.showWarningMessage(`Delete package version ${version ?? id}?`, { modal: true }, "Delete");
    if (ok !== "Delete") return;
    await this.runAction(
      `Deleting ${version ?? id}`,
      ["package", "version", "delete", "--package", id, "--target-dev-hub", hub, "--no-prompt"],
      "deleteVersion"
    );
    await this.reloadHub();
  }

  private static async updateVersion(id?: string, version?: string): Promise<void> {
    if (!id) return;
    const hub = PackageExplorerPanelProvider._selectedHub;
    if (!hub) return;
    const name = await vscode.window.showInputBox({ prompt: `New version name for ${version ?? id} (blank = unchanged)` });
    if (name === undefined) return;
    const description = await vscode.window.showInputBox({ prompt: "New version description (blank = unchanged)" });
    if (description === undefined) return;
    const tag = await vscode.window.showInputBox({ prompt: "New tag (blank = unchanged)" });
    if (tag === undefined) return;
    const args = ["package", "version", "update", "--package", id, "--target-dev-hub", hub];
    if (name) args.push("--version-name", name);
    if (description) args.push("--version-description", description);
    if (tag) args.push("--tag", tag);
    if (args.length === 6) {
      vscode.window.showInformationMessage("Nothing to update.");
      return;
    }
    await this.runAction(`Updating ${version ?? id}`, args, "updateVersion");
    await this.reloadHub();
  }

  private static async updatePackage(pkgId?: string, currentName?: string): Promise<void> {
    if (!pkgId) return;
    const hub = PackageExplorerPanelProvider._selectedHub;
    if (!hub) return;
    const name = await vscode.window.showInputBox({ prompt: "Package name", value: currentName });
    if (name === undefined) return;
    const description = await vscode.window.showInputBox({ prompt: "New description (blank = unchanged)" });
    if (description === undefined) return;
    const args = ["package", "update", "--package", pkgId, "--target-dev-hub", hub];
    if (name && name !== currentName) args.push("--name", name);
    if (description) args.push("--description", description);
    if (args.length === 6) {
      vscode.window.showInformationMessage("Nothing to update.");
      return;
    }
    await this.runAction(`Updating package ${currentName ?? pkgId}`, args, "updatePackage");
    await this.reloadHub();
  }

  private static async versionReport(id?: string): Promise<void> {
    const panel = PackageExplorerPanelProvider._panel;
    if (!panel || !id) return;
    const hub = PackageExplorerPanelProvider._selectedHub;
    if (!hub) return;
    try {
      const raw = await runCommandArgs(
        "sf",
        ["package", "version", "report", "--package", id, "--target-dev-hub", hub, "--json"],
        undefined,
        undefined,
        false
      );
      const r = (JSON.parse(raw) as { result?: Record<string, unknown> }).result ?? {};
      const deps = ((r.Dependencies as { ids?: { subscriberPackageVersionId: string }[] } | undefined)?.ids ?? []).map(
        (d) => d.subscriberPackageVersionId
      );
      const report = {
        coverage: this.coverageString(r.CodeCoverage),
        passedCoverage: this.asBool(r.HasPassedCodeCoverageCheck),
        ancestor: this.str(r.AncestorVersion) ?? this.str(r.AncestorId),
        released: this.asBool(r.IsReleased),
        createdBy: this.str(r.CreatedBy),
        installUrl: this.str(r.InstallUrl),
        dependencies: deps
      };
      panel.webview.postMessage({ command: "setReport", id, report });
    } catch (error) {
      panel.webview.postMessage({ command: "setReport", id, report: { error: this.errorText(error) } });
    }
  }

  private static async exportCurrent(pkgId?: string, format: "md" | "csv" = "md"): Promise<void> {
    const pkgs = PackageExplorerPanelProvider._packageCache.get(PackageExplorerPanelProvider._selectedHub ?? "") ?? [];
    const pkg = pkgs.find((p) => p.id === pkgId);
    if (!pkg) return;
    const header = ["Version", "SubscriberPackageVersionId", "Released", "Coverage", "Created", "Tag"];
    const rows = pkg.versions.map((v) => [
      v.version,
      v.subscriberPackageVersionId,
      v.released ? "released" : "beta",
      v.coverage ?? "",
      (v.createdDate ?? "").substring(0, 10),
      v.tag ?? ""
    ]);
    if (format === "md") {
      const md = [
        `# ${pkg.name} (${pkg.id})`,
        "",
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...rows.map((r) => `| ${r.join(" | ")} |`)
      ].join("\n");
      await vscode.env.clipboard.writeText(md);
      vscode.window.setStatusBarMessage("Version table copied as Markdown", 2500);
    } else {
      const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
      const uri = await vscode.window.showSaveDialog({
        filters: { CSV: ["csv"] },
        saveLabel: "Export versions",
        defaultUri: vscode.Uri.file(`${pkg.name.replace(/\W+/g, "_")}_versions.csv`)
      });
      if (!uri) return;
      fs.writeFileSync(uri.fsPath, csv, "utf8");
      vscode.window.showInformationMessage(`Exported ${rows.length} versions to ${path.basename(uri.fsPath)}`);
    }
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  private static async runAction(title: string, args: string[], event: string): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => runCommandArgs("sf", [...args, "--json"], undefined, undefined, false, LONG_TIMEOUT_MS)
      );
      vscode.window.showInformationMessage(`${title} — done.`);
      Telemetry.event("packageExplorer", { status: "action", action: event });
    } catch (error) {
      vscode.window.showErrorMessage(`${title} failed: ${this.errorText(error)}`);
      Telemetry.error("packageExplorerError", { reason: categorizeError(error), action: event });
    }
  }

  /** Invalidate the current hub's cache and reload hub-mode packages. */
  private static async reloadHub(): Promise<void> {
    const hub = PackageExplorerPanelProvider._selectedHub;
    if (hub) PackageExplorerPanelProvider._packageCache.delete(hub);
    await this.load(true);
  }

  private static async pickOrg(placeHolder: string): Promise<OrgOption | undefined> {
    const raw = await runCommandArgs("sf", ["org", "list", "--json"], undefined, undefined, false);
    const parsed = JSON.parse(raw) as {
      result?: {
        nonScratchOrgs?: { username?: string; alias?: string }[];
        scratchOrgs?: { username?: string; alias?: string }[];
      };
    };
    const orgs: OrgOption[] = [
      ...(parsed.result?.nonScratchOrgs ?? []).map((o) => ({ username: o.username ?? "", alias: o.alias, scratch: false })),
      ...(parsed.result?.scratchOrgs ?? []).map((o) => ({ username: o.username ?? "", alias: o.alias, scratch: true }))
    ].filter((o) => o.username);
    const items = orgs.map((o) => ({
      label: o.alias || o.username,
      description: o.username + (o.scratch ? "  (scratch)" : ""),
      org: o
    }));
    const chosen = await vscode.window.showQuickPick(items, { placeHolder });
    return chosen?.org;
  }

  private static versionString(v: Record<string, unknown>): string {
    if (v.Version) return String(v.Version);
    const parts = [v.MajorVersion, v.MinorVersion, v.PatchVersion, v.BuildNumber];
    if (parts.every((n) => n === undefined || n === null)) return "";
    return parts.map((n) => (n === undefined || n === null ? "0" : String(n))).join(".");
  }

  /** True if version a > b, comparing dotted numeric parts. */
  private static versionGt(a: string, b: string): boolean {
    const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const da = pa[i] ?? 0;
      const db = pb[i] ?? 0;
      if (da !== db) return da > db;
    }
    return false;
  }

  private static coverageString(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string") return v;
    if (typeof v === "number") return `${v}%`;
    if (typeof v === "object") {
      const pct = (v as { apexCodeCoveragePercentage?: number }).apexCodeCoveragePercentage;
      if (typeof pct === "number") return `${pct}%`;
    }
    return undefined;
  }

  private static str(v: unknown): string | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    return String(v);
  }

  private static asBool(v: unknown): boolean | undefined {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const l = v.trim().toLowerCase();
      if (l === "yes" || l === "true") return true;
      if (l === "no" || l === "false") return false;
    }
    return undefined;
  }

  private static errorText(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      const parsed = JSON.parse(msg) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      /* not JSON */
    }
    return this.truncate(msg, 500);
  }

  private static truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ── Webview HTML ────────────────────────────────────────────────────────────

  private static getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        * { box-sizing: border-box; }
        body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
        h2 { margin: 0 0 12px 0; font-weight: 600; }
        .tabs { display: flex; gap: 4px; margin-bottom: 12px; }
        .tab { padding: 5px 12px; border-radius: 4px 4px 0 0; cursor: pointer; border: 1px solid transparent; color: var(--vscode-descriptionForeground); }
        .tab.active { color: var(--vscode-foreground); border-color: var(--vscode-widget-border); border-bottom-color: transparent; background: var(--vscode-editor-inactiveSelectionBackground); }
        .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
        .toolbar label { color: var(--vscode-descriptionForeground); }
        select, button { padding: 5px 10px; font-size: 12px; border-radius: 4px; border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent)); }
        select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); max-width: 300px; }
        input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); padding: 5px 8px; font-size: 12px; border-radius: 4px; }
        input:focus { outline: 1px solid var(--vscode-focusBorder); }
        .subbar { margin: -4px 0 12px 0; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
        .subbar input[type="search"] { width: 300px; max-width: 100%; }
        .chk { display: inline-flex; gap: 5px; align-items: center; color: var(--vscode-descriptionForeground); }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
        button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        button.link { background: none; border: none; color: var(--vscode-textLink-foreground); padding: 2px 4px; cursor: pointer; }
        button.danger { color: var(--vscode-errorForeground); }
        button:hover { opacity: 0.9; }
        .spacer { flex: 1; }

        /* combobox */
        .combo { position: relative; width: 300px; }
        .combo input { width: 100%; }
        .combo-list { position: absolute; top: calc(100% + 2px); left: 0; right: 0; max-height: 320px; overflow-y: auto; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; z-index: 30; display: none; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
        .combo-list.open { display: block; }
        .combo-opt { padding: 6px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .combo-opt.active, .combo-opt:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

        /* floating action menu */
        .menu { position: absolute; display: none; z-index: 60; min-width: 190px; padding: 4px; border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-dropdown-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); box-shadow: 0 3px 10px rgba(0,0,0,0.4); }
        .menu.open { display: block; }
        .menu-item { display: block; width: 100%; text-align: left; background: none; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; color: var(--vscode-menu-foreground, var(--vscode-foreground)); }
        .menu-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); }
        .menu-item.danger { color: var(--vscode-errorForeground); }
        .menu-sep { height: 1px; margin: 4px 0; background: var(--vscode-widget-border); }

        .pkg { border: 1px solid var(--vscode-widget-border); border-radius: 6px; margin-bottom: 14px; overflow: hidden; }
        .pkg-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--vscode-editor-inactiveSelectionBackground); flex-wrap: wrap; }
        .pkg-name { font-weight: 600; font-size: 14px; }
        .badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .badge.up { background: var(--vscode-testing-iconPassed, #3fb950); color: #06210d; }
        .mono { font-family: var(--vscode-editor-font-family, monospace); }
        .id-chip { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); cursor: pointer; border: 1px solid var(--vscode-widget-border); }
        .id-chip:hover { border-color: var(--vscode-focusBorder); }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 6px 12px; border-top: 1px solid var(--vscode-widget-border); vertical-align: middle; }
        th { color: var(--vscode-descriptionForeground); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
        td.actions { white-space: nowrap; text-align: right; }
        td.actions button { padding: 3px 8px; margin-left: 4px; }
        .kebab { padding: 3px 9px !important; font-weight: 700; }
        .tick { color: var(--vscode-testing-iconPassed, #3fb950); }
        .muted { color: var(--vscode-descriptionForeground); }
        .deps { padding: 8px 12px; border-top: 1px solid var(--vscode-widget-border); display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 12px; }
        .dep { display: inline-flex; align-items: center; gap: 5px; }
        .no-versions { padding: 10px 12px; color: var(--vscode-descriptionForeground); font-style: italic; }
        .status { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
        .error { padding: 14px 16px; border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.1)); border-radius: 6px; white-space: pre-wrap; }
        .report td { background: var(--vscode-textBlockQuote-background); font-size: 12px; }
        .report .mono { display: block; margin-top: 3px; word-break: break-all; }
    </style>
</head>
<body>
    <h2>Package Explorer</h2>
    <div class="tabs">
        <div class="tab active" id="tab-hub">Dev Hub packages</div>
        <div class="tab" id="tab-installed">Installed in org</div>
    </div>

    <div class="toolbar" id="hubbar">
        <label for="hub">Dev Hub</label>
        <select id="hub"></select>
        <label>Package</label>
        <div class="combo" id="combo">
            <input id="pkgInput" type="text" placeholder="Search package…" autocomplete="off">
            <div class="combo-list" id="pkgList"></div>
        </div>
        <div class="spacer"></div>
    </div>
    <div class="subbar" id="subbar" style="display:none">
        <input id="verSearch" type="search" placeholder="Filter versions (version, 04t, tag)…" autocomplete="off">
        <label class="chk"><input type="checkbox" id="releasedOnly"> Released only</label>
        <label class="chk"><input type="checkbox" id="latestOnly"> Latest per package</label>
        <label class="chk" title="Loads code coverage for every version — slower on large packages"><input type="checkbox" id="verbose"> Coverage (slower)</label>
        <div class="spacer"></div>
        <button class="link" id="exportMd">Export MD</button>
        <button class="link" id="exportCsv">Export CSV</button>
    </div>

    <div class="toolbar" id="instbar" style="display:none">
        <span class="muted" id="instOrg"></span>
        <div class="spacer"></div>
        <button id="pickOrg" class="secondary">Choose org…</button>
        <button id="refreshInst" class="secondary">Refresh</button>
    </div>

    <div id="content"></div>
    <div class="menu" id="menu"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const tabHub = document.getElementById('tab-hub');
        const tabInst = document.getElementById('tab-installed');
        const hubbar = document.getElementById('hubbar');
        const instbar = document.getElementById('instbar');
        const hubSel = document.getElementById('hub');
        const combo = document.getElementById('combo');
        const pkgInput = document.getElementById('pkgInput');
        const pkgList = document.getElementById('pkgList');
        const subbar = document.getElementById('subbar');
        const verSearch = document.getElementById('verSearch');
        const releasedOnly = document.getElementById('releasedOnly');
        const latestOnly = document.getElementById('latestOnly');
        const instOrg = document.getElementById('instOrg');
        const content = document.getElementById('content');
        const menu = document.getElementById('menu');
        const PROD = 'https://login.salesforce.com';
        const SANDBOX = 'https://test.salesforce.com';
        let mode = 'hub';
        let packages = [];
        let installed = [];
        let selectedPkgId = null;
        let comboActive = 0;
        const reports = {};

        const esc = (t) => (t == null ? '' : String(t)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const installUrl = (id, base) => base + '/packaging/installPackage.apexp?p0=' + id;
        const installCmd = (id) => 'sf package install --package ' + id + ' --target-org <your-org> --wait 10';
        const depSnippet = (v) => JSON.stringify({ package: v.alias || v.subscriberPackageVersionId }, null, 2);
        const post = (o) => vscode.postMessage(o);
        const chip = (text, copyText, title) => '<span class="id-chip" title="' + esc(title || 'Copy') + '" data-copy="' + esc(copyText || text) + '">' + esc(text) + '</span>';

        // ── searchable combobox ──────────────────────────────────────────────
        function comboMatches() {
            const q = pkgInput.value.trim().toLowerCase();
            const sel = packages.find(p => p.id === selectedPkgId);
            if (!q || (sel && q === sel.name.toLowerCase())) return packages;
            return packages.filter(p => (p.name||'').toLowerCase().includes(q) || (p.namespace||'').toLowerCase().includes(q) || (p.id||'').toLowerCase().includes(q) || (p.alias||'').toLowerCase().includes(q));
        }
        function renderCombo() {
            const list = comboMatches();
            if (comboActive >= list.length) comboActive = Math.max(0, list.length - 1);
            pkgList.innerHTML = list.length
                ? list.map((p,i) => '<div class="combo-opt' + (i === comboActive ? ' active' : '') + '" data-id="' + esc(p.id) + '">' + esc(p.name) + ' <span class="muted">(' + p.versions.length + ')</span></div>').join('')
                : '<div class="combo-opt muted">No matches</div>';
        }
        function openCombo() { pkgList.classList.add('open'); renderCombo(); }
        function closeCombo() { pkgList.classList.remove('open'); }
        function chooseCombo(id) {
            selectedPkgId = id;
            const p = packages.find(x => x.id === id);
            pkgInput.value = p ? p.name : '';
            closeCombo();
            renderHub();
        }
        pkgInput.addEventListener('focus', () => { pkgInput.select(); comboActive = 0; openCombo(); });
        pkgInput.addEventListener('input', () => { comboActive = 0; pkgList.classList.add('open'); renderCombo(); });
        pkgInput.addEventListener('keydown', e => {
            const list = comboMatches();
            if (e.key === 'ArrowDown') { comboActive = Math.min(comboActive + 1, list.length - 1); renderCombo(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { comboActive = Math.max(comboActive - 1, 0); renderCombo(); e.preventDefault(); }
            else if (e.key === 'Enter') { if (list[comboActive]) chooseCombo(list[comboActive].id); e.preventDefault(); }
            else if (e.key === 'Escape') { closeCombo(); pkgInput.blur(); }
        });
        pkgList.addEventListener('mousedown', e => { const o = e.target.closest('.combo-opt'); if (o && o.dataset.id) { e.preventDefault(); chooseCombo(o.dataset.id); } });
        document.addEventListener('click', e => { if (!combo.contains(e.target)) closeCombo(); if (!menu.contains(e.target) && !e.target.closest('.kebab')) menu.classList.remove('open'); });

        // ── floating action menu ─────────────────────────────────────────────
        function showMenu(anchor, items) {
            menu.innerHTML = items.map((it,i) => it.sep ? '<div class="menu-sep"></div>' : '<button class="menu-item' + (it.danger ? ' danger' : '') + '" data-i="' + i + '">' + esc(it.label) + '</button>').join('');
            const r = anchor.getBoundingClientRect();
            menu.style.top = (window.scrollY + r.bottom + 3) + 'px';
            menu.style.left = (window.scrollX + Math.max(8, Math.min(r.right - 190, window.innerWidth - 210))) + 'px';
            menu.classList.add('open');
            menu.querySelectorAll('.menu-item').forEach(b => b.addEventListener('click', () => { const it = items[parseInt(b.getAttribute('data-i'),10)]; menu.classList.remove('open'); it.onClick(); }));
        }
        function versionMenu(v) {
            const id = v.subscriberPackageVersionId;
            const items = [{ label: 'Copy 04t Id', onClick: () => post({ command: 'copy', text: id }) }];
            if (v.alias) items.push({ label: 'Copy alias', onClick: () => post({ command: 'copy', text: v.alias }) });
            items.push({ label: 'Copy dependency snippet', onClick: () => post({ command: 'copy', text: depSnippet(v) }) });
            items.push({ sep: true });
            items.push({ label: 'Version report (deps + ancestry)', onClick: () => post({ command: 'report', id }) });
            items.push({ label: 'Update version…', onClick: () => post({ command: 'updateVersion', id, version: v.version }) });
            items.push({ label: 'Delete version…', danger: true, onClick: () => post({ command: 'deleteVersion', id, version: v.version }) });
            return items;
        }

        // ── rendering ────────────────────────────────────────────────────────
        function currentPackage() { return packages.find(p => p.id === selectedPkgId) || null; }
        function depsHtml(p) {
            const deps = p.dependencies || [];
            if (!deps.length) return '';
            return '<div class="deps"><span class="muted">Dependencies:</span>' +
                deps.map(d => '<span class="dep">' + esc(d.label) + (d.versionNumber ? ' <span class="muted">' + esc(d.versionNumber) + '</span>' : '') + (d.id ? chip(d.id, d.id, 'Copy dependency id') : '') + '</span>').join('') +
                '</div>';
        }
        function visibleVersions(p) {
            let vs = p.versions;
            if (releasedOnly.checked) vs = vs.filter(v => v.released);
            if (latestOnly.checked) vs = vs.slice(0, 1);
            const q = verSearch.value.trim().toLowerCase();
            if (q) vs = vs.filter(v => (v.version||'').toLowerCase().includes(q) || (v.subscriberPackageVersionId||'').toLowerCase().includes(q) || (v.tag||'').toLowerCase().includes(q) || (v.name||'').toLowerCase().includes(q));
            return vs;
        }
        function rowHtml(v) {
            const created = v.createdDate ? esc(v.createdDate.substring(0,10)) : '';
            const id = esc(v.subscriberPackageVersionId);
            const cov = v.coverage ? '<span class="' + (v.passedCoverage ? 'tick' : 'muted') + '">' + esc(v.coverage) + '</span>' : '<span class="muted">—</span>';
            const rep = reports[v.subscriberPackageVersionId];
            let repHtml = '';
            if (rep) {
                repHtml = '<tr class="report"><td colspan="6">' + (rep.error
                    ? '<span class="muted">' + esc(rep.error) + '</span>'
                    : (rep.coverage ? '<span class="mono">Coverage: ' + esc(rep.coverage) + (rep.passedCoverage ? ' ✔' : '') + '</span>' : '') +
                      (rep.ancestor ? 'Ancestor: <span class="mono">' + esc(rep.ancestor) + '</span>' : '<span class="muted">No ancestor</span>') +
                      '<span class="mono">Dependencies: ' + ((rep.dependencies && rep.dependencies.length) ? rep.dependencies.map(esc).join(', ') : 'none') + '</span>' +
                      (rep.installUrl ? '<span class="mono">Install URL: ' + esc(rep.installUrl) + '</span>' : '')) +
                    '</td></tr>';
            }
            return '<tr>' +
                '<td class="mono">' + esc(v.version) + (v.alias ? ' <span class="muted">' + esc(v.alias) + '</span>' : '') + (v.tag ? ' <span class="muted">#' + esc(v.tag) + '</span>' : '') + '</td>' +
                '<td>' + chip(v.subscriberPackageVersionId, v.subscriberPackageVersionId, 'Copy 04t') + '</td>' +
                '<td>' + (v.released ? '<span class="tick">✔ released</span>' : '<span class="muted">beta</span>') + (v.passwordProtected ? ' <span class="badge">pwd</span>' : '') + '</td>' +
                '<td>' + cov + '</td>' +
                '<td class="muted">' + created + '</td>' +
                '<td class="actions">' +
                    '<button data-install="' + id + '" data-prot="' + (v.passwordProtected ? '1' : '0') + '" data-name="' + esc(v.version) + '">Install…</button>' +
                    (v.released ? '' : '<button class="secondary" data-promote="' + id + '" data-version="' + esc(v.version) + '">Promote</button>') +
                    '<button class="secondary" data-prod="' + id + '">Prod URL</button>' +
                    '<button class="secondary" data-sandbox="' + id + '">Sandbox URL</button>' +
                    '<button class="link" data-copycmd="' + id + '">cmd</button>' +
                    '<button class="secondary kebab" data-menu="' + id + '" title="More actions">⋯</button>' +
                '</td>' +
            '</tr>' + repHtml;
        }
        function renderHub() {
            if (!packages.length) { subbar.style.display = 'none'; content.innerHTML = '<div class="status">No 2GP packages found in this Dev Hub.</div>'; return; }
            const p = currentPackage();
            if (!p) { subbar.style.display = 'none'; content.innerHTML = '<div class="status">No package selected.</div>'; return; }
            subbar.style.display = 'flex';
            const head = '<div class="pkg-head">' +
                '<span class="pkg-name">' + esc(p.name) + '</span>' +
                (p.alias ? '<span class="badge">' + esc(p.alias) + '</span>' : '') +
                (p.type ? '<span class="badge">' + esc(p.type) + '</span>' : '') +
                (p.namespace ? '<span class="muted mono">' + esc(p.namespace) + '</span>' : '<span class="muted">no namespace</span>') +
                (p.isOrgDependent ? '<span class="badge">org-dependent</span>' : '') +
                chip(p.id, p.id, 'Copy 0Ho') +
                '<span class="muted">' + p.versions.length + ' version' + (p.versions.length === 1 ? '' : 's') + ' · ' + p.versions.filter(v => v.released).length + ' released</span>' +
                '<div class="spacer"></div>' +
                '<button class="secondary" data-renamepkg="' + esc(p.id) + '" data-name="' + esc(p.name) + '">✎ Edit name</button>' +
                '</div>';
            const deps = depsHtml(p);
            if (!p.versions.length) { content.innerHTML = '<div class="pkg">' + head + deps + '<div class="no-versions">No versions created yet.</div></div>'; wire(); return; }
            const vs = visibleVersions(p);
            if (!vs.length) { content.innerHTML = '<div class="pkg">' + head + deps + '<div class="no-versions">No versions match the filter.</div></div>'; wire(); return; }
            content.innerHTML = '<div class="pkg">' + head + deps +
                '<table><thead><tr><th>Version</th><th>04t</th><th>Status</th><th>Coverage</th><th>Created</th><th></th></tr></thead>' +
                '<tbody>' + vs.map(rowHtml).join('') + '</tbody></table></div>';
            wire();
        }
        function renderInstalled() {
            if (!installed.length) { content.innerHTML = '<div class="status">No packages installed in this org (or none reported).</div>'; return; }
            const rows = installed.map(p => '<tr>' +
                '<td>' + esc(p.name) + '</td>' +
                '<td class="muted mono">' + esc(p.namespace || '') + '</td>' +
                '<td class="mono">' + esc(p.version) + '</td>' +
                '<td>' + chip(p.subscriberPackageVersionId, p.subscriberPackageVersionId, 'Copy 04t') + '</td>' +
                '<td>' + (p.upgradeId ? '<span class="badge up">↑ ' + esc(p.upgradeVersion) + '</span>' : '<span class="muted">up to date</span>') + '</td>' +
                '<td class="actions">' +
                    (p.upgradeId ? '<button data-upgrade="' + esc(p.upgradeId) + '" data-name="' + esc(p.name) + '">Upgrade</button>' : '') +
                    '<button class="secondary danger" data-uninstall="' + esc(p.subscriberPackageVersionId) + '" data-name="' + esc(p.name) + '">Uninstall</button>' +
                '</td>' +
            '</tr>').join('');
            content.innerHTML = '<div class="pkg"><table><thead><tr><th>Package</th><th>Namespace</th><th>Version</th><th>04t</th><th>Upgrade</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
            wire();
        }
        function wire() {
            const on = (attr, fn) => content.querySelectorAll('[' + attr + ']').forEach(el => el.addEventListener('click', (ev) => fn(el, ev)));
            on('data-copy', el => post({ command: 'copy', text: el.getAttribute('data-copy') }));
            on('data-prod', el => post({ command: 'copy', text: installUrl(el.getAttribute('data-prod'), PROD) }));
            on('data-sandbox', el => post({ command: 'copy', text: installUrl(el.getAttribute('data-sandbox'), SANDBOX) }));
            on('data-copycmd', el => post({ command: 'copy', text: installCmd(el.getAttribute('data-copycmd')) }));
            on('data-install', el => post({ command: 'install', id: el.getAttribute('data-install'), name: el.getAttribute('data-name'), protected: el.getAttribute('data-prot') }));
            on('data-upgrade', el => post({ command: 'upgrade', id: el.getAttribute('data-upgrade'), name: el.getAttribute('data-name') }));
            on('data-uninstall', el => post({ command: 'uninstall', id: el.getAttribute('data-uninstall'), name: el.getAttribute('data-name') }));
            on('data-promote', el => post({ command: 'promote', id: el.getAttribute('data-promote'), version: el.getAttribute('data-version') }));
            on('data-renamepkg', el => post({ command: 'updatePackage', pkgId: el.getAttribute('data-renamepkg'), name: el.getAttribute('data-name') }));
            on('data-menu', (el, ev) => { ev.stopPropagation(); const p = currentPackage(); const v = p && p.versions.find(x => x.subscriberPackageVersionId === el.getAttribute('data-menu')); if (v) showMenu(el, versionMenu(v)); });
        }

        // ── mode + toolbar events ────────────────────────────────────────────
        function setModeUi(m) {
            mode = m;
            tabHub.classList.toggle('active', m === 'hub');
            tabInst.classList.toggle('active', m === 'installed');
            hubbar.style.display = m === 'hub' ? 'flex' : 'none';
            instbar.style.display = m === 'installed' ? 'flex' : 'none';
            if (m !== 'hub') subbar.style.display = 'none';
        }
        tabHub.addEventListener('click', () => { if (mode !== 'hub') { setModeUi('hub'); content.innerHTML = ''; post({ command: 'setMode', mode: 'hub' }); } });
        tabInst.addEventListener('click', () => { if (mode !== 'installed') { setModeUi('installed'); content.innerHTML = ''; post({ command: 'setMode', mode: 'installed' }); } });
        hubSel.addEventListener('change', () => post({ command: 'selectHub', hub: hubSel.value }));
        verSearch.addEventListener('input', renderHub);
        releasedOnly.addEventListener('change', renderHub);
        latestOnly.addEventListener('change', renderHub);
        document.getElementById('verbose').addEventListener('change', (e) => post({ command: 'setVerbose', on: e.target.checked ? '1' : '0' }));
        document.getElementById('exportMd').addEventListener('click', () => post({ command: 'exportMd', pkgId: selectedPkgId }));
        document.getElementById('exportCsv').addEventListener('click', () => post({ command: 'exportCsv', pkgId: selectedPkgId }));
        document.getElementById('pickOrg').addEventListener('click', () => post({ command: 'pickInstalledOrg' }));
        document.getElementById('refreshInst').addEventListener('click', () => post({ command: 'pickInstalledOrg' }));

        window.addEventListener('message', e => {
            const m = e.data || {};
            if (m.command === 'setLoading' && m.loading) { content.innerHTML = '<div class="status">Loading…</div>'; }
            else if (m.command === 'setHubs') {
                hubSel.innerHTML = m.hubs.map(h => '<option value="' + esc(h.username) + '"' + (h.username === m.selected ? ' selected' : '') + '>' + esc(h.alias || h.username) + (h.isDefault ? ' (default)' : '') + '</option>').join('');
            }
            else if (m.command === 'setPackages') {
                setModeUi('hub');
                packages = m.packages || [];
                if (!packages.some(p => p.id === selectedPkgId)) selectedPkgId = packages.length ? packages[0].id : null;
                const sel = packages.find(p => p.id === selectedPkgId);
                pkgInput.value = sel ? sel.name : '';
                renderHub();
            }
            else if (m.command === 'setInstalled') { setModeUi('installed'); installed = m.packages || []; instOrg.textContent = 'Installed in: ' + m.org; renderInstalled(); }
            else if (m.command === 'setReport') { reports[m.id] = m.report; renderHub(); }
            else if (m.command === 'setMode') { setModeUi(m.mode); }
            else if (m.command === 'setError') { subbar.style.display = 'none'; content.innerHTML = '<div class="error">' + esc(m.message) + '</div>'; }
        });
    </script>
</body>
</html>`;
  }
}
