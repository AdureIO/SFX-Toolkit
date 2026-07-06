import * as vscode from 'vscode';

const outputChannel = vscode.window.createOutputChannel("Adure SFX Toolkit");

export class Logger {
    static info(message: string) {
        this.log('INFO', message);
    }

    static error(message: string, error?: any) {
        let errorMsg = message;
        if (error) {
            const details = error instanceof Error 
                ? error.message 
                : typeof error === 'string' 
                    ? error 
                    : JSON.stringify(error, null, 2);

            errorMsg += `\nError Details: ${details}`;

            if (error instanceof Error && error.stack) {
                errorMsg += `\nStack: ${error.stack}`;
            }
        }
        this.log('ERROR', errorMsg);
        // Optionally show error message to user for critical errors, but usually log is enough or handled by caller
    }

    static warn(message: string) {
        this.log('WARN', message);
    }

    private static log(level: string, message: string) {
        const timestamp = new Date().toISOString();
        outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);
    }

    static show() {
        outputChannel.show();
    }
}

export { outputChannel };

// Dedicated channel for deploy/push/validate status + failures, so the (often
// noisy, per-poll) deploy output doesn't bury other logs. The deploy notifications'
// "View Log" action opens THIS channel.
const deployChannel = vscode.window.createOutputChannel("Adure SFX Toolkit - Deploy");

export class DeployLog {
    /** Append a timestamped line to the deploy channel. */
    static line(message: string) {
        deployChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
    static show() {
        deployChannel.show();
    }
    static clear() {
        deployChannel.clear();
    }
}

export { deployChannel };
