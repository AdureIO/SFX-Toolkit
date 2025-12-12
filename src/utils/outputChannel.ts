import * as vscode from 'vscode';

const outputChannel = vscode.window.createOutputChannel("Adure SFX Toolkit");

export class Logger {
    static info(message: string) {
        this.log('INFO', message);
    }

    static error(message: string, error?: any) {
        let errorMsg = message;
        if (error) {
            errorMsg += `\nError Details: ${error instanceof Error ? error.message : JSON.stringify(error)}`;
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
