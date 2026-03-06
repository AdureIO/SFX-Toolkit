import * as vscode from 'vscode';
import { createTrace } from './traceCommands';
import { runCommand } from '../utils/commandRunner';

export async function addDebugTrace() {
    try {
        let targetUserId: string | null = null;
        let targetLevelId: string | null = null;

        // 1. Select User
        let userItems: vscode.QuickPickItem[] = [];
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Fetching Users...",
            cancellable: true
        }, async (_progress, token) => {
            const usersQuery = "SELECT Id, Name, Username FROM User WHERE IsActive = true ORDER BY Name LIMIT 50";
            const usersRes = await runCommand(`sf data query -q "${usersQuery}" --json`, undefined, undefined, true, token);
            const usersJson = JSON.parse(usersRes);
            
            userItems.push({
                label: "$(person) Current User",
                description: "Use the currently authenticated user",
                detail: "current"
            });
            
            if (usersJson.status === 0 && usersJson.result.records) {
                usersJson.result.records.forEach((u: any) => {
                    userItems.push({
                        label: u.Name,
                        description: u.Username,
                        detail: u.Id
                    });
                });
            }
        }).then(undefined, (e: any) => { if (e.cancelled) throw e; });

        const selectedUser = await vscode.window.showQuickPick(userItems, {
            placeHolder: 'Select User for Trace (or use Current User)'
        });
        
        if (!selectedUser) return;
        if (selectedUser.detail !== 'current') {
            targetUserId = selectedUser.detail!;
        }

        // 2. Select Debug Level
        let levelItems: vscode.QuickPickItem[] = [];

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Fetching Debug Levels...",
            cancellable: true
        }, async (_progress, token) => {
            const levelsQuery = "SELECT Id, DeveloperName FROM DebugLevel ORDER BY DeveloperName";
            const levelsRes = await runCommand(`sf data query -q "${levelsQuery}" -t --json`, undefined, undefined, true, token);
            const levelsJson = JSON.parse(levelsRes);
            
            if (levelsJson.status === 0 && levelsJson.result.records) {
                 levelsJson.result.records.forEach((l: any) => {
                    levelItems.push({
                        label: l.DeveloperName,
                        detail: l.Id
                    });
                });
            }
        }).then(undefined, (e: any) => { if (e.cancelled) throw e; });

        if (levelItems.length === 0) {
            vscode.window.showWarningMessage('No Debug Levels found in Org. Please create one first.');
            return;
        }

        const selectedLevel = await vscode.window.showQuickPick(levelItems, {
            placeHolder: 'Select Debug Level'
        });
        
        if (!selectedLevel) return;
        targetLevelId = selectedLevel.detail!;

        // 3. Select Duration
        const durationStr = await vscode.window.showInputBox({
            prompt: 'Enter duration in minutes (1-1440)',
            value: '60',
            validateInput: (val) => {
                const n = parseInt(val, 10);
                if (isNaN(n) || n < 1 || n > 1440) return 'Duration must be between 1 and 1440 minutes.';
                return null;
            }
        });
        if (!durationStr) return;
        const duration = parseInt(durationStr, 10);

        // Call the shared createTrace
        await createTrace(duration, targetUserId, targetLevelId);

    } catch (e: any) {
        if (e.cancelled) return;
        vscode.window.showErrorMessage(`Failed to start flow: ${e.message || e}`);
    }
}
