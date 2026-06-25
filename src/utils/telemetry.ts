import * as vscode from "vscode";
import { TelemetryReporter } from "@vscode/extension-telemetry";
import { Logger } from "./outputChannel";

// ─── Configuration ──────────────────────────────────────────────────────────
//
// Application Insights connection string. This is NOT a secret in the
// marketplace sense — telemetry connection strings are designed to ship inside
// published extensions.
const CONNECTION_STRING = "InstrumentationKey=1f6e6d5b-dfe4-42c7-9a9f-f82caf823c6c;IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/;LiveEndpoint=https://westeurope.livediagnostics.monitor.azure.com/;ApplicationId=dc56576d-4b89-4f4b-8293-05bb1ddc3ff7";

const INSTALL_ID_KEY = "adure-sfx-toolkit.installId";

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around @vscode/extension-telemetry. Collects fully anonymous
 * usage data (command ids, categorical flags, numeric measurements). Never
 * sends payloads, query/code text, org ids, usernames, file paths, or any PII.
 *
 * Sends are gated on BOTH our own `adure-sfx-toolkit.telemetry.enabled` setting
 * and VS Code's global telemetry level (the reporter also enforces the latter).
 */
export class Telemetry {
  private static reporter: TelemetryReporter | undefined;
  private static installId: string | undefined;

  /** Call once from activate(). */
  static init(context: vscode.ExtensionContext): void {
    try {
      this.reporter = new TelemetryReporter(CONNECTION_STRING);
      context.subscriptions.push(this.reporter);

      // Stable-per-install anonymous id (secondary to VS Code's machineId).
      let id = context.globalState.get<string>(INSTALL_ID_KEY);
      if (!id) {
        id = generateUuid();
        void context.globalState.update(INSTALL_ID_KEY, id);
      }
      this.installId = id;
    } catch (error) {
      Logger.error("Telemetry: failed to initialize reporter", error);
      this.reporter = undefined;
    }
  }

  /** True when telemetry should be sent (our opt-out AND VS Code global). */
  static isEnabled(): boolean {
    if (!this.reporter) return false;
    const optedIn = vscode.workspace
      .getConfiguration("adure-sfx-toolkit")
      .get<boolean>("telemetry.enabled", true);
    return optedIn && vscode.env.isTelemetryEnabled;
  }

  /** Send a usage event. No-ops when disabled. */
  static event(
    name: string,
    properties?: Record<string, string>,
    measurements?: Record<string, number>
  ): void {
    if (!this.isEnabled()) return;
    try {
      this.reporter!.sendTelemetryEvent(name, this.withCommon(properties), measurements);
    } catch (error) {
      Logger.error(`Telemetry: failed to send event '${name}'`, error);
    }
  }

  /** Send an error/failure event (categorical only — never raw messages). */
  static error(
    name: string,
    properties?: Record<string, string>,
    measurements?: Record<string, number>
  ): void {
    if (!this.isEnabled()) return;
    try {
      this.reporter!.sendTelemetryErrorEvent(name, this.withCommon(properties), measurements);
    } catch (error) {
      Logger.error(`Telemetry: failed to send error event '${name}'`, error);
    }
  }

  private static withCommon(properties?: Record<string, string>): Record<string, string> {
    return { ...(this.installId ? { installId: this.installId } : {}), ...properties };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Bucket an arbitrary error into a coarse, PII-free category so we can see
 * *which kinds* of failures happen without ever sending the raw message.
 */
export function categorizeError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!msg) return "unknown";
  if (/(unauthorized|401|expired|invalid_grant|no such org|not authorized|login)/.test(msg)) {
    return "auth";
  }
  if (/(enotfound|econnrefused|etimedout|network|fetch failed|socket|getaddrinfo)/.test(msg)) {
    return "network";
  }
  if (/(command failed|sf:|sfdx|cli|spawn|enoent)/.test(msg)) {
    return "cli";
  }
  if (/(timeout|timed out)/.test(msg)) {
    return "timeout";
  }
  return "unknown";
}

/** RFC4122 v4 UUID without pulling in a dependency. */
function generateUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
