import { runCommand } from './commandRunner';
import { outputChannel } from './outputChannel';

interface OrgAuth {
    accessToken: string;
    instanceUrl: string;
    username: string;
}

export class AuthInfo {
    private static cachedAuth: OrgAuth | null = null;
    private static isFetching = false;

    public static async getAuthInfo(): Promise<OrgAuth | null> {
        if (this.cachedAuth) {
            return this.cachedAuth;
        }

        // Debounce if multiple calls happen at startup
        if (this.isFetching) {
            // Simple wait (not perfect but avoids double CLI calls)
            await new Promise(r => setTimeout(r, 1000)); 
            if (this.cachedAuth) return this.cachedAuth;
        }
        
        this.isFetching = true;
        try {
            outputChannel.appendLine('AuthInfo: Retrieving Org credentials for faster API access...');
            // Assumes default target org. If multiple orgs supported later, need to pass username.
            const result = await runCommand('sf org display --json');
            const parsed = JSON.parse(result);
            
            if (parsed.status === 0 && parsed.result) {
                this.cachedAuth = {
                    accessToken: parsed.result.accessToken,
                    instanceUrl: parsed.result.instanceUrl,
                    username: parsed.result.username
                };
                outputChannel.appendLine(`AuthInfo: Connected to ${this.cachedAuth.instanceUrl}`);
                return this.cachedAuth;
            } else {
                outputChannel.appendLine(`AuthInfo Failed: ${parsed.message}`);
                return null;
            }
        } catch (e) {
            outputChannel.appendLine(`AuthInfo Error: ${e}`);
            return null;
        } finally {
            this.isFetching = false;
        }
    }
    
    public static clearCache() {
        this.cachedAuth = null;
    }
}
