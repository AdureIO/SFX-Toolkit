/**
 * Background re-probe of orgs whose connection was confirmed bad: with back-off (1, 2, 5, then every
 * 10 min) one cheap authenticated request per org. A success goes through AuthInfo.withRetry, which
 * clears the problem itself, so a connection that recovered (re-login in a terminal, a concurrent
 * refresh by another tool) heals without any user action. Runs until login / recovery.
 */
import { AuthInfo } from "./authInfo";
import { AuthReprobeScheduler } from "./authHealthPure";
import { allSchemaProblems, NO_ORG_KEY } from "./schemaHealth";
import { outputChannel } from "./outputChannel";

const TICK_MS = 30_000;

/** Starts the loop; returns a disposer. */
export function startAuthReprobe(): () => void {
	const scheduler = new AuthReprobeScheduler();
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			const keys = allSchemaProblems()
				.filter((p) => p.state === "authInvalid" && !p.scratchExpired && p.orgKey !== NO_ORG_KEY)
				.map((p) => p.orgKey);
			for (const key of scheduler.due(keys)) {
				try {
					await AuthInfo.get(key, (a) => `${a.instanceUrl.replace(/\/$/, "")}/services/oauth2/userinfo`);
					outputChannel.appendLine(`AuthReprobe: ${key} answers again`);
				} catch {
					/* still broken: the next window retries */
				}
			}
		} finally {
			running = false;
		}
	};
	const timer = setInterval(() => void tick(), TICK_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}
