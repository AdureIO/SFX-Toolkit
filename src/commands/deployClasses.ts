import * as vscode from 'vscode';
import * as glob from 'glob';
import * as path from 'path';
import { runCommand } from '../utils/commandRunner';

export async function deployClasses() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace open');
        return;
    }

    // 1. Find all Apex Classes in the workspace (excluding tests if we can guess, but here we list all)
    // Common pattern: force-app/main/default/classes/*.cls
    const classFiles = glob.sync('**/*.cls', { cwd: workspaceRoot, ignore: ['**/node_modules/**', '**/bin/**'] });

    if (classFiles.length === 0) {
        vscode.window.showErrorMessage('No Apex classes found in workspace.');
        return;
    }

    // 2. Select Classes to Deploy is too tedious if there are hundreds.
    // Let's ask: "Deploy currently open file" or "Select from list"?
    // The requirement said: "easily deploy classes to production (with selecting test classes...)"
    // Let's assume selecting from a list.
    
    // Sort files
    const items = classFiles.map(f => ({ label: path.basename(f), description: f }));
    const selectedClasses = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select Apex Classes to deploy'
    });

    if (!selectedClasses || selectedClasses.length === 0) return;

    // 3. Select Test Classes
    // Find files ending in Test.cls or grep for @isTest matching files?
    // Let's filter the list we already have for names ending in Test or starting with Test.
    const testClassCandidates = items.filter(i => i.label.toLowerCase().includes('test'));
    
    // User might want to run ANY test, so show all as candidates, but pre-select the ones that look like tests?
    // Or just show the refined list.
    const selectedTests = await vscode.window.showQuickPick(items, { // Show all items as potential tests
        canPickMany: true,
        placeHolder: 'Select Test Classes to run (optional)',
    });
    
    // 4. Construct Command
    const classPaths = selectedClasses.map(c => `"${c.description}"`).join(' ');
    // If we pass paths to deploy, sf usually deploys the metadata.
    // However, sf project deploy start -d "path/to/class1" -d "path/to/class2"
    
    // CLI syntax: `sf project deploy start --source-dir path/to/dir` or `-d path/to/file`
    // We need to build the `-d` args.
    const sourceArgs = selectedClasses.map(c => `-d "${c.description}"`).join(' '); // Note: paths must be relative or absolute. glob gave relative.
    
    let testArgs = '';
    if (selectedTests && selectedTests.length > 0) {
        // -l RunSpecifiedTests -t Test1 -t Test2
        // Test names are class names (without .cls)
        const testNames = selectedTests.map(t => path.basename(t.label, '.cls')).join(' ');
        // sf syntax: -t Test1 -t Test2
        const testFlags = selectedTests.map(t => `-t ${path.basename(t.label, '.cls')}`).join(' ');
        testArgs = `-l RunSpecifiedTests ${testFlags}`;
    } else {
        // If no tests, default to whatever org requires (usually RunLocalTests or NoTestRun for scratch orgs)
        // Production usually requires tests.
        // We'll leave it to default if empty, or prompt?
        // Let's assume default unless forced.
        // But user asked "selecting test classes that need to run".
    }
    
    // 5. Run Command
    // Usage: sf project deploy start [flags]
    const cmd = `sf project deploy start ${sourceArgs} ${testArgs}`;

    const terminal = vscode.window.createTerminal("Salesforce Deploy");
    terminal.show();
    terminal.sendText(cmd);
}
