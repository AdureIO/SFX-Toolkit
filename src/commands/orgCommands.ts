import * as vscode from "vscode";
import { reportError } from "../utils/reportError";
import { runCommandArgs } from "../utils/commandRunner";
import { getOrgListResult, getOrgByTarget, getOrgListForPicker, invalidateOrgListCache } from "../utils/orgListCache";
import { OrgItem, orgTreeProvider } from "../providers/OrgTreeProvider";
import { AuthInfo } from "../utils/authInfo";
import { Logger } from "../utils/outputChannel";
import { notifyDefaultOrgChanged } from "../utils/defaultOrgEvents";
import { invalidateOrgKeyCache } from "../utils/orgKey";
import { primaryProjectRoot, isMdapiProject } from "../utils/projectUtils";
import { NO_ORG_KEY, onLoginCompletedHealth } from "../utils/schemaHealth";

/** Scratch org creation regularly exceeds the default 5-minute command timeout. */
const SCRATCH_CREATE_TIMEOUT_MS = 30 * 60 * 1000;

export async function openOrg(item: OrgItem) {
  if (!item.orgData || !item.orgData.username) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Opening Org ${item.label}...`,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        await runCommandArgs("sf", ["org", "open", "-o", item.orgData.username], undefined, undefined, true, undefined, token);
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Open org", error: e });
      }
    }
  );
}

export async function setAsDefault(item: OrgItem) {
  if (!item.orgData || !item.orgData.username) return;

  // An MDAPI project has no sfdx-project.json, so a local config cannot be written: use the global one.
  const globalDefault = isMdapiProject();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Setting ${item.label} as Default...`,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        const args = ["config", "set", `target-org=${item.orgData.username}`];
        if (globalDefault) args.push("--global");
        await runCommandArgs("sf", args, primaryProjectRoot(), undefined, true, undefined, token);
        // Invalidate default-org caches, refresh the org list, and notify listeners
        // (the workbenches realign their selected org). No-op if already this default.
        await notifyDefaultOrgChanged(item.orgData.username);
        vscode.window.showInformationMessage(
          globalDefault
            ? `Set ${item.label} as default org (global: this MDAPI project has no local config, so it applies to all projects).`
            : `Set ${item.label} as default org.`
        );
        orgTreeProvider.refresh();
        vscode.commands.executeCommand("adure-sfx-toolkit.refreshTraces");
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Set default org", error: e });
      }
    }
  );
}

export async function setAsDefaultDevHub(item: OrgItem) {
  if (!item.orgData || !item.orgData.username) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Setting ${item.label} as Default Dev Hub...`,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        const hubArgs = ["config", "set", `target-dev-hub=${item.orgData.username}`];
        if (isMdapiProject()) hubArgs.push("--global"); // no sfdx-project.json to hold a local config
        await runCommandArgs("sf", hubArgs, primaryProjectRoot(), undefined, true, undefined, token);
        AuthInfo.clearCache();
        vscode.window.showInformationMessage(`Set ${item.label} as default Dev Hub.`);
        orgTreeProvider.refresh();
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Set default Dev Hub", error: e });
      }
    }
  );
}

export async function copyUsername(item: OrgItem) {
  if (!item.orgData || !item.orgData.username) return;
  await vscode.env.clipboard.writeText(item.orgData.username);
  vscode.window.showInformationMessage(`Copied username: ${item.orgData.username}`);
}

export async function deleteOrg(item: OrgItem) {
  if (!item.orgData || !item.orgData.username) return;

  // Check if scratch or regular
  const isScratch = item.contextValue === "org-scratch";
  const action = isScratch ? "Deleting Scratch Org" : "Logging out from Org";
  const args = isScratch
    ? ["org", "delete", "scratch", "-o", item.orgData.username, "-p"]
    : ["org", "logout", "-o", item.orgData.username, "-p"];

  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to ${action.toLowerCase()} "${item.orgData.username}"?`,
    "Yes",
    "No"
  );

  if (confirm !== "Yes") return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${action}...`,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        await runCommandArgs("sf", args, undefined, undefined, true, undefined, token);
        AuthInfo.clearCache();
        vscode.window.showInformationMessage(`${action} successful.`);
        orgTreeProvider.refresh();
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Delete/logout org", error: e });
      }
    }
  );
}

export async function generatePassword(item: OrgItem) {
  if (!item.orgData || !item.orgData.username) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating password for ${item.label}...`,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        const res = await runCommandArgs(
          "sf",
          ["org", "generate", "password", "-o", item.orgData.username, "--json"],
          undefined,
          undefined,
          true,
          undefined,
          token
        );
        const json = JSON.parse(res);
        if (json.status === 0 && json.result && json.result.password) {
          // Show password and offering to copy
          const pwd = json.result.password;
          await vscode.env.clipboard.writeText(pwd);
          vscode.window.showInformationMessage("Password generated and copied to clipboard.");
        } else {
          vscode.window.showErrorMessage("Failed to generate password.");
        }
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Generate password", error: e });
      }
    }
  );
}

export async function renameAlias(item: OrgItem) {
  if (!item.orgData || !item.orgData.username) return;

  // Existing alias
  let oldAlias = item.orgData.alias || "";
  if (!oldAlias && typeof item.label === "string") {
    oldAlias = item.label;
  }
  oldAlias = oldAlias.replace(/^\s*●\s*/, "");

  let newAlias = await vscode.window.showInputBox({
    prompt: `Enter new alias for ${item.orgData.username}`,
    value: oldAlias
  });

  if (!newAlias) return;
  newAlias = newAlias.replace(/^\s*●\s*/, "");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Setting alias...`,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        if (oldAlias && oldAlias !== newAlias) {
          await runCommandArgs("sf", ["alias", "unset", oldAlias], undefined, undefined, true, undefined, token);
        }
        await runCommandArgs("sf", ["alias", "set", `${newAlias}=${item.orgData.username}`], undefined, undefined, true, undefined, token);
        orgTreeProvider.refresh();
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Rename alias", error: e });
      }
    }
  );
}

export async function connectOrg() {
  // 1. Ask for Alias
  const alias = await vscode.window.showInputBox({
    prompt: "Enter an alias for the new org",
    placeHolder: "my-org"
  });
  if (!alias) return;

  // 2. Ask for Instance URL
  const urlPick = await vscode.window.showQuickPick(
    [
      { label: "Production", detail: "https://login.salesforce.com" },
      { label: "Sandbox", detail: "https://test.salesforce.com" },
      { label: "Custom", detail: "Enter custom URL" }
    ],
    { placeHolder: "Select Login URL" }
  );
  if (!urlPick) return;

  let instanceUrl = urlPick.detail;
  if (urlPick.label === "Custom") {
    const customUrl = await vscode.window.showInputBox({
      prompt: "Enter Custom Login URL",
      value: "https://my-domain.my.salesforce.com"
    });
    if (!customUrl) return;
    instanceUrl = customUrl;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to Org (${alias})... Check your browser.`,
      cancellable: true
    },
    async (progress, token) => {
      try {
        await runCommandArgs(
          "sf",
          ["org", "login", "web", "--alias", alias, "--instance-url", instanceUrl!, "--set-default"],
          undefined,
          undefined,
          true,
          undefined,
          token
        );
        AuthInfo.clearCache();
        onLoginCompletedHealth();
        vscode.window.showInformationMessage(`Successfully connected to ${alias}.`);
        orgTreeProvider.refresh();
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Connect org", error: e });
      }
    }
  );
}

export async function createScratch() {
  try {
    // 1. Dev Hub (With Loader)
    let targetDevHub = "";
    let hubs: any[] = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fetching Dev Hubs...",
        cancellable: false
      },
      async () => {
        try {
          // Shared, deduplicated org list (reuses a fetch from the last minute).
          const orgs = await getOrgListResult({ maxAgeMs: 60_000 });
          hubs = (orgs.nonScratchOrgs || []).filter((o: any) => o.isDevHub);
        } catch (e: any) {
          if (e.cancelled) throw e;
          Logger.error("Error fetching dev hubs", e);
        }
      }
    );

    if (hubs.length === 0) {
      vscode.window.showErrorMessage("No Dev Hubs found. Please authorize a Dev Hub first.");
      return;
    }

    const hubPick = await vscode.window.showQuickPick<vscode.QuickPickItem>(
      hubs.map((h: any) => ({
        label: h.alias || h.username,
        description: h.isDefaultDevHubUsername ? "(Default)" : "",
        detail: h.username
      })),
      { placeHolder: "Select Dev Hub" }
    );
    if (!hubPick) return; // Cancelled
    targetDevHub = hubPick.detail || "";

    // 2. Definition File
    const configFiles = await vscode.workspace.findFiles("config/*.json", "**/node_modules/**");

    if (configFiles.length === 0) {
      vscode.window.showErrorMessage("No scratch definition files found in config/.");
      return;
    }

    const filePick = await vscode.window.showQuickPick(
      configFiles.map((f) => {
        const name = vscode.workspace.asRelativePath(f);
        return { label: name, uri: f };
      }),
      { placeHolder: "Select Definition File" }
    );
    if (!filePick) return;
    const fileUri = filePick.uri;

    // READ JSON CONTENT for Defaults
    let defJson: any = {};
    try {
      const content = await vscode.workspace.fs.readFile(fileUri);
      defJson = JSON.parse(content.toString());
    } catch (e) {
      Logger.warn("Failed to read definition file for defaults: " + e);
    }

    // 3. Alias (Default to orgName or filename)
    let defaultAlias = defJson.orgName || filePick.label.replace(".json", "");
    // Clean alias if it has spaces
    defaultAlias = defaultAlias.replace(/\s+/g, "-");

    const alias = await vscode.window.showInputBox({
      prompt: "Enter Scratch Org Alias",
      value: defaultAlias,
      placeHolder: "e.g. feature-x"
    });
    if (!alias) return;

    // 4. Duration
    const duration = await vscode.window.showInputBox({
      prompt: "Duration (Days)",
      value: "30",
      validateInput: (val) => {
        const n = parseInt(val);
        if (isNaN(n) || n < 1 || n > 30) return "Duration must be between 1 and 30.";
        return null;
      }
    });
    if (!duration) return;

    // Command Construction (argv — alias / orgName / paths are never shell-parsed)
    const args = [
      "org", "create", "scratch",
      "-f", fileUri.fsPath,
      "-a", alias,
      "--duration-days", String(parseInt(duration, 10)),
      "-v", targetDevHub,
      "--set-default"
    ];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating Scratch Org (${alias})...`,
        cancellable: true
      },
      async (_progress, token) => {
        try {
          await runCommandArgs("sf", args, undefined, undefined, true, SCRATCH_CREATE_TIMEOUT_MS, token);
          vscode.window.showInformationMessage(`Scratch Org ${alias} created successfully.`);
          orgTreeProvider.refresh();
        } catch (e: any) {
          if (e.cancelled) return;
          throw e;
        }
      }
    );
  } catch (e: any) {
    if (e.cancelled) return;
    reportError({ operation: "Create scratch org", error: e });
  }
}

export async function quickScratch() {
  try {
    // 1. Definition File
    const configFiles = await vscode.workspace.findFiles("config/*.json", "**/node_modules/**");
    let defFile = "";
    let defFileUri: vscode.Uri | undefined;

    if (configFiles.length === 0) {
      vscode.window.showErrorMessage("No definition files found.");
      return;
    } else if (configFiles.length === 1) {
      defFile = configFiles[0].fsPath;
      defFileUri = configFiles[0];
    } else {
      const filePick = await vscode.window.showQuickPick(
        configFiles.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f })),
        { placeHolder: "Select Definition File" }
      );
      if (!filePick) return;
      defFile = filePick.uri.fsPath;
      defFileUri = filePick.uri;
    }

    // READ JSON CONTENT for alias/orgName
    let defJson: any = {};
    let defaultAlias = "quick-scratch";
    try {
      if (defFileUri) {
        const content = await vscode.workspace.fs.readFile(defFileUri);
        defJson = JSON.parse(content.toString());
        // Use orgName from definition, or fallback to filename
        if (defJson.orgName) {
          defaultAlias = defJson.orgName.replace(/\s+/g, "-");
        } else {
          defaultAlias = vscode.workspace.asRelativePath(defFileUri).replace(".json", "").replace("config/", "");
        }
      }
    } catch (e) {
      Logger.warn("Failed to read definition file for alias: " + e);
    }

    // 2. Alias (with smart default from definition)
    const alias = await vscode.window.showInputBox({
      prompt: "Enter Scratch Org Alias",
      value: defaultAlias,
      placeHolder: "e.g. quick-scratch"
    });
    if (!alias) return;

    // 3. Create (Defaults: 30 days, default hub)
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating Quick Scratch Org (${alias})...`,
        cancellable: true
      },
      async (_progress, token) => {
        try {
          await runCommandArgs(
            "sf",
            ["org", "create", "scratch", "-f", defFile, "-a", alias, "--duration-days", "30", "--set-default"],
            undefined,
            undefined,
            true,
            SCRATCH_CREATE_TIMEOUT_MS,
            token
          );
          vscode.window.showInformationMessage(`Scratch Org ${alias} created.`);
          orgTreeProvider.refresh();
        } catch (e: any) {
          if (e.cancelled) return;
          throw e;
        }
      }
    );
  } catch (e: any) {
    if (e.cancelled) return;
    reportError({ operation: "Quick scratch org", error: e });
  }
}

/**
 * Pick one of the connected orgs (expired scratch orgs left out) and make it the default of
 * `projectDir` (omitted = the primary project). Used by the schema-health quick pick.
 */
export async function chooseDefaultOrg(projectDir?: string): Promise<void> {
  const orgs = (await getOrgListForPicker()).filter((o) => !getOrgByTarget(o.username)?.isExpired);
  if (!orgs.length) {
    const pick = await vscode.window.showInformationMessage("No connected orgs. Connect one first.", "Connect org…");
    if (pick) await connectOrg();
    return;
  }
  const picked = await vscode.window.showQuickPick(
    orgs.map((o) => ({ label: o.label.replace(/ \(default\)$/, ""), description: o.username, username: o.username })),
    { placeHolder: "Select the default org for this project", matchOnDescription: true }
  );
  if (!picked) return;
  try {
    await runCommandArgs("sf", ["config", "set", `target-org=${picked.username}`], projectDir);
    const primary = primaryProjectRoot();
    if (!projectDir || projectDir === primary) {
      await notifyDefaultOrgChanged(picked.username);
    } else {
      // A nested project: its config watcher announces the change; drop what it resolved before.
      invalidateOrgKeyCache(projectDir);
    }
    vscode.window.showInformationMessage(`Set ${picked.label} as default org.`);
    orgTreeProvider.refresh();
  } catch (e: any) {
    reportError({ operation: "Set default org", error: e });
  }
}

/**
 * Re-run the web login for an org whose connection is expired / revoked, with the alias and
 * login URL the CLI already knows for it. Clears the health problem when it completes.
 */
export async function reauthenticateOrg(orgKey: string): Promise<void> {
  const rec = orgKey && orgKey !== NO_ORG_KEY ? getOrgByTarget(orgKey) : null;
  const args = ["org", "login", "web"];
  if (rec?.alias) args.push("--alias", rec.alias);
  if (rec?.instanceUrl) args.push("--instance-url", rec.instanceUrl);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Re-authenticating ${rec?.alias || rec?.username || "org"}... Check your browser.`,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        await runCommandArgs("sf", args, undefined, undefined, true, undefined, token);
        AuthInfo.clearCache();
        invalidateOrgListCache();
        onLoginCompletedHealth();
        vscode.window.showInformationMessage("Re-authenticated. Schema features are restored.");
        orgTreeProvider.refresh();
        void vscode.commands.executeCommand("adure-sfx-toolkit.refreshOrgs");
      } catch (e: any) {
        if (e.cancelled) return;
        reportError({ operation: "Re-authenticate org", error: e });
      }
    }
  );
}
