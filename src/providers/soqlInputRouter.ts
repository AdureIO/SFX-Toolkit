/**
 * Host side of a webview SOQL input (src/webview/monacoSoqlInput.ts): routes its
 * completion / hover / resolve / cancel / org / validate messages onto ONE buffer
 * bridge (one virtual `asfx-buffer:` document per panel) and posts the answers back.
 *
 * Pure (no `vscode` import) so it's unit tested with a fake bridge; the real wiring is
 * createSoqlInputRouter() in soqlInputBridge.ts.
 */
import type { BridgeRequest } from "./apexBufferBridge";
import type { WireCompletionItem, WireCompletionResult, WireHover } from "./bufferBridgeCore";
import { SOQL_INPUT_MSG } from "../webview/monacoSoqlInput";

/** The subset of ApexBufferBridge the router uses. */
export interface SoqlBufferBridgeLike {
	completions(req: BridgeRequest): Promise<(WireCompletionResult & { listId: number }) | null>;
	hover(req: BridgeRequest): Promise<WireHover | null>;
	resolveCompletion(listId: number, resolveId: number, requestId?: number): Promise<WireCompletionItem | null>;
	cancel(requestId: number): void;
	setOrg(org: string | null): boolean;
	dispose(): void;
}

export interface SoqlMarkerLike {
	line: number;
	startCol: number;
	endCol: number;
	message: string;
}

/** Normalise a webview request payload. */
export function bridgeRequestFrom(message: Record<string, unknown>): BridgeRequest {
	return {
		requestId: typeof message.requestId === "number" ? message.requestId : undefined,
		text: typeof message.text === "string" ? message.text : "",
		line: typeof message.line === "number" ? message.line : 0,
		character: typeof message.character === "number" ? message.character : 0,
		triggerKind: typeof message.triggerKind === "number" ? message.triggerKind : undefined,
		triggerCharacter: typeof message.triggerCharacter === "string" ? message.triggerCharacter : undefined,
	};
}

/** `org` field of a message: undefined when absent, null for "" (default org). */
function orgOf(m: Record<string, unknown>): string | null | undefined {
	return typeof m.org === "string" ? m.org || null : undefined;
}

export class SoqlInputRouter {
	private _disposed = false;
	private readonly _inFlight = new Set<number>();
	private _active = 0;

	constructor(
		private readonly _bridge: SoqlBufferBridgeLike,
		private readonly _post: (message: unknown) => unknown,
		private readonly _markers?: (org: string | null, text: string) => Promise<SoqlMarkerLike[]>,
	) {
		// Registers the buffer as ephemeral (no stub writes) and starts at the default org.
		this._bridge.setOrg(null);
	}

	get disposed(): boolean {
		return this._disposed;
	}

	/** Handle a webview message. Returns true when it was a SOQL-input message. */
	async handle(message: unknown): Promise<boolean> {
		if (!message || typeof message !== "object") return false;
		const m = message as Record<string, unknown>;
		const requestId = typeof m.requestId === "number" ? m.requestId : undefined;
		switch (m.command) {
			case SOQL_INPUT_MSG.completion:
				await this._run(requestId, async () => {
					const res = await this._bridge.completions(bridgeRequestFrom(m));
					this._send(res
						? { command: SOQL_INPUT_MSG.completion, requestId, items: res.items, incomplete: res.incomplete, listId: res.listId }
						: { command: SOQL_INPUT_MSG.completion, requestId, dropped: true });
				}, m);
				return true;
			case SOQL_INPUT_MSG.hover:
				await this._run(requestId, async () => {
					this._send({ command: SOQL_INPUT_MSG.hover, requestId, hover: await this._bridge.hover(bridgeRequestFrom(m)) });
				}, m);
				return true;
			case SOQL_INPUT_MSG.resolve:
				await this._run(requestId, async () => {
					const item = await this._bridge.resolveCompletion(Number(m.listId), Number(m.resolveId), requestId);
					this._send({ command: SOQL_INPUT_MSG.resolve, requestId, item });
				}, m, false);
				return true;
			case SOQL_INPUT_MSG.cancel:
				if (requestId !== undefined && !this._disposed) this._bridge.cancel(requestId);
				return true;
			case SOQL_INPUT_MSG.setOrg:
				// Targeted LS refresh only when the effective org actually changed.
				if (!this._disposed) this._bridge.setOrg(orgOf(m) ?? null);
				return true;
			case SOQL_INPUT_MSG.validate: {
				if (this._disposed || !this._markers) return true;
				const text = typeof m.text === "string" ? m.text : "";
				let markers: SoqlMarkerLike[] = [];
				try { markers = await this._markers(orgOf(m) ?? null, text); } catch { /* no markers */ }
				// Echo input + text: the webview applies markers only to that editor, still unchanged.
				this._send({ command: SOQL_INPUT_MSG.markers, input: m.input, text, markers });
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * Run one request. A request carrying `org` first pins the buffer's org (cheap no-op
	 * when unchanged). A request that finishes after dispose() re-runs the bridge's
	 * cleanup — its sync may have re-opened the virtual document.
	 */
	private async _run(requestId: number | undefined, fn: () => Promise<void>, m: Record<string, unknown>, applyOrg = true): Promise<void> {
		if (this._disposed) return;
		if (applyOrg) {
			const org = orgOf(m);
			if (org !== undefined) this._bridge.setOrg(org);
		}
		if (requestId !== undefined) this._inFlight.add(requestId);
		this._active++;
		try {
			await fn();
		} catch {
			// Never leave the webview's request pending: `dropped` resolves it as empty.
			this._send({ command: m.command, requestId, dropped: true });
		} finally {
			this._active--;
			if (requestId !== undefined) this._inFlight.delete(requestId);
			if (this._disposed && this._active === 0) this._bridge.dispose();
		}
	}

	private _send(message: unknown): void {
		if (this._disposed) return;
		try {
			void Promise.resolve(this._post(message)).catch(() => undefined);
		} catch { /* webview gone */ }
	}

	/** Panel closed: cancel in-flight requests, close the virtual document, drop the org override. */
	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		for (const id of this._inFlight) this._bridge.cancel(id);
		this._bridge.dispose();
	}
}
