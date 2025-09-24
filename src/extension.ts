import * as vscode from 'vscode';
import { ClaudeSyncService } from './syncService';

let syncService: ClaudeSyncService;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
	console.log('Dev Environment Helper extension is now active!');

	// Initialize Claude Sync Service
	syncService = new ClaudeSyncService();
	await syncService.initialize();

	// Create status bar item
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'claudeSync.showStatus';
	updateStatusBar();
	statusBarItem.show();

	// Hello World command (legacy)
	let helloWorld = vscode.commands.registerCommand('dev-env-helper.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from Dev Environment Helper!');
	});

	// Claude Sync commands
	let syncNow = vscode.commands.registerCommand('claudeSync.syncNow', async () => {
		const config = vscode.workspace.getConfiguration('claudeSync');
		if (!config.get('enabled')) {
			const enable = await vscode.window.showInformationMessage(
				'Claude Sync is disabled. Enable it first?',
				'Enable',
				'Cancel'
			);
			if (enable === 'Enable') {
				await vscode.commands.executeCommand('claudeSync.openSettings');
			}
			return;
		}

		// Check authentication
		const isAuthenticated = await syncService.ensureAuthenticated();
		if (!isAuthenticated) {
			const signIn = await vscode.window.showInformationMessage(
				'Please sign in to GitHub to enable Claude Sync.',
				'Sign In',
				'Cancel'
			);
			if (signIn === 'Sign In') {
				// Try to authenticate again, this time forcing the auth flow
				await vscode.authentication.getSession('github', ['gist'], { createIfNone: true });
				if (!(await syncService.ensureAuthenticated())) {
					vscode.window.showErrorMessage('GitHub authentication failed. Please try again.');
					return;
				}
			} else {
				return;
			}
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Syncing Claude configuration...',
			cancellable: false
		}, async () => {
			await syncService.performSync();
		});

		const status = syncService.getSyncStatus();
		if (status.errors.length > 0) {
			vscode.window.showErrorMessage(`Sync completed with errors: ${status.errors[0]}`);
		} else {
			vscode.window.showInformationMessage('Claude configuration synced successfully!');
		}
	});

	let showStatus = vscode.commands.registerCommand('claudeSync.showStatus', () => {
		const status = syncService.getSyncStatus();
		const lastSync = status.lastSync ? new Date(status.lastSync).toLocaleString() : 'Never';
		const statusMsg = `
Last Sync: ${lastSync}
Currently Syncing: ${status.issyncing ? 'Yes' : 'No'}
Conflicts: ${status.conflicts.length}
Errors: ${status.errors.length}
		`.trim();

		vscode.window.showInformationMessage(statusMsg);
	});

	let openSettings = vscode.commands.registerCommand('claudeSync.openSettings', async () => {
		try {
			// Try the direct settings search first
			await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSync');
		} catch (error) {
			// Fallback: open general settings and show info message
			await vscode.commands.executeCommand('workbench.action.openSettings');
			vscode.window.showInformationMessage('Search for "claudeSync" in the settings to configure Claude Sync options.');
		}
	});

	// Register all commands
	context.subscriptions.push(helloWorld, syncNow, showStatus, openSettings);

	// Listen for configuration changes
	const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
		if (e.affectsConfiguration('claudeSync')) {
			// Reinitialize service with new config
			syncService.dispose();
			syncService = new ClaudeSyncService();
			await syncService.initialize();
		}
	});

	context.subscriptions.push(configWatcher, statusBarItem);

	// Function to update status bar
	function updateStatusBar() {
		const config = vscode.workspace.getConfiguration('claudeSync');
		if (!config.get('enabled')) {
			statusBarItem.hide();
			return;
		}

		const status = syncService.getSyncStatus();
		const lastSync = status.lastSync ? new Date(status.lastSync).toLocaleString() : 'Never';

		if (status.issyncing) {
			statusBarItem.text = "$(sync~spin) Claude Sync: Syncing...";
			statusBarItem.tooltip = "Claude configuration sync in progress";
		} else if (status.errors.length > 0) {
			statusBarItem.text = "$(error) Claude Sync: Error";
			statusBarItem.tooltip = `Claude Sync Error: ${status.errors[0]}`;
		} else {
			statusBarItem.text = "$(cloud) Claude Sync";
			statusBarItem.tooltip = `Claude Sync - Last sync: ${lastSync}`;
		}

		statusBarItem.show();
	}

	// Update status bar periodically
	setInterval(updateStatusBar, 10000); // Update every 10 seconds
}

export function deactivate() {
	if (syncService) {
		syncService.dispose();
	}
}