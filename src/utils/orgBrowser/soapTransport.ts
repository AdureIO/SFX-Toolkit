/**
 * Metadata API SOAP transport for the Org Browser: session from AuthInfo (401/INVALID_SESSION_ID
 * triggers the single-flight token refresh), POST via httpsPost. Read-only usage only.
 */
import { AuthInfo } from "../authInfo";
import { httpsPost } from "../httpUtils";
import { buildEnvelope, faultMessage } from "./metadataLister";

const SOAP_TIMEOUT_MS = 180_000;

/** Returns a `call(operationXml)` function bound to one org + API version (e.g. "67.0"). */
export function makeSoapCall(org: string | null, apiVersion: string): (operationXml: string) => Promise<string> {
	return (operationXml: string) =>
		AuthInfo.withAuth(org, async (auth) => {
			const url = `${auth.instanceUrl.replace(/\/+$/, "")}/services/Soap/m/${apiVersion}`;
			const body = buildEnvelope(auth.accessToken, operationXml);
			try {
				return await httpsPost(url, body, { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: '""' }, SOAP_TIMEOUT_MS);
			} catch (e: any) {
				const msg = String(e?.message ?? e);
				const fault = faultMessage(msg);
				// SOAP reports an expired session as an HTTP 500 fault; map it to 401 so AuthInfo refreshes and retries.
				if (/INVALID_SESSION_ID/i.test(msg)) throw new Error(`HTTP 401: ${fault ?? "INVALID_SESSION_ID"}`);
				if (fault) {
					const err = new Error(fault) as Error & { status?: number };
					const status = Number(/^HTTP (\d{3})/.exec(msg)?.[1]);
					if (status) err.status = status;
					throw err;
				}
				throw e;
			}
		});
}
