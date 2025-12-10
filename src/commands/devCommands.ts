import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';
import * as fs from 'fs';
import * as path from 'path';

export async function pushSource() {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Pushing Source...",
        cancellable: false
    }, async (progress) => { // Use progress to report step updates
        try {
            // 1. Detect sfdx-project.json
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                // Fallback
                await runCommand('sf project deploy start');
                vscode.window.showInformationMessage('Source pushed successfully (No workspace).');
                return;
            }

            const rootPath = workspaceFolders[0].uri.fsPath;
            const projectJsonPath = path.join(rootPath, 'sfdx-project.json');

            let packageDirs: string[] = [];
            
            if (fs.existsSync(projectJsonPath)) {
                try {
                    const content = fs.readFileSync(projectJsonPath, 'utf8');
                    const projectConfig = JSON.parse(content);
                    if (projectConfig.packageDirectories && Array.isArray(projectConfig.packageDirectories)) {
                         // Extract paths in order
                         packageDirs = projectConfig.packageDirectories.map((pkg: any) => pkg.path);
                    }
                } catch (jsonErr) {
                    console.error("Error parsing sfdx-project.json", jsonErr);
                }
            }

            if (packageDirs.length > 0) {
                // Sequential Deployment
                progress.report({ message: `Found ${packageDirs.length} package directories.` });
                
                for (const pkgDir of packageDirs) {
                    const fullPkgPath = path.join(rootPath, pkgDir);
                    // Check if it exists before trying to deploy
                    if (!fs.existsSync(fullPkgPath)) continue;

                    progress.report({ message: `Deploying ${pkgDir}...` });
                    // runCommand logic
                    await runCommand(`sf project deploy start -d "${fullPkgPath}"`);
                }
                vscode.window.showInformationMessage(`Successfully pushed source for ${packageDirs.length} packages.`);

            } else {
                // Default Deployment (Standard logic)
                progress.report({ message: "Deploying project..." });
                await runCommand('sf project deploy start');
                vscode.window.showInformationMessage('Source pushed successfully.');
            }
            
        } catch (e: any) {
            vscode.window.showErrorMessage(`Push failed: ${e.message}`);
        }
    });
}

export async function pullSource() {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Pulling Source from Default Org...",
        cancellable: false
    }, async () => {
        try {
            await runCommand('sf project retrieve start');
            vscode.window.showInformationMessage('Source pulled successfully.');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
        }
    });
}

export async function deployCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("No active editor.");
        return;
    }
    
    const filePath = editor.document.uri.fsPath;
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deploying current file...",
        cancellable: false
    }, async () => {
        try {
            // Use --source-dir or -d to deploy specific file/path
            await runCommand(`sf project deploy start -d "${filePath}"`);
            vscode.window.showInformationMessage('File deployed successfully.');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Deploy failed: ${e.message}`);
        }
    });
}

export async function retrieveCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("No active editor.");
        return;
    }
    
    const filePath = editor.document.uri.fsPath;
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Retrieving current file...",
        cancellable: false
    }, async () => {
        try {
            await runCommand(`sf project retrieve start -d "${filePath}"`);
            vscode.window.showInformationMessage('File retrieved successfully.');
        } catch (e: any) {
             vscode.window.showErrorMessage(`Retrieve failed: ${e.message}`);
        }
    });
}

export async function runLocalTests() {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Running Local Tests...",
        cancellable: true
    }, async (progress, token) => {
        try {
            // -w 10 (wait 10 mins), -l RunLocalTests, -r human
            // Use runCommand but maybe output to channel?
            // Tests can have long output.
            
            const result = await runCommand('sf apex run test -l RunLocalTests -w 10 -r human');
            
            const channel = vscode.window.createOutputChannel("Salesforce Test Results");
            channel.clear();
            channel.append(result);
            channel.show();
            
            if (result.includes('Pass') && !result.includes('Fail')) {
                 vscode.window.showInformationMessage('Tests Passed.');
            } else {
                 vscode.window.showWarningMessage('Some tests failed. Check output.');
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`Tests execution failed.`);
            const channel = vscode.window.createOutputChannel("Salesforce Test Results");
            channel.append(e.stderr || e.message);
            channel.show();
        }
    });
}
