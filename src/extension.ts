import * as vscode from 'vscode';
import * as path from 'path';
import { ClaudeSyncService } from './syncService';
import { EnvironmentService, EnvVariable } from './envService';
import { EnvironmentViewProvider } from './environmentViewProvider';
import { OnePasswordService } from './onePasswordService';

let syncService: ClaudeSyncService;
let envService: EnvironmentService;
let environmentViewProvider: EnvironmentViewProvider;
let statusBarItem: vscode.StatusBarItem;
let configChangeTimeout: NodeJS.Timeout | undefined;
let autoSyncTimeouts: Map<string, NodeJS.Timeout> = new Map();
let remoteDataLoaded: boolean = false;

function isRunningInDevContainer(): boolean {
	// Method 1: Check remote environment
	if (vscode.env.remoteName === 'dev-container') {
		return true;
	}

	// Method 2: Check environment variables
	if (process.env.REMOTE_CONTAINERS === 'true' || process.env.CODESPACES === 'true') {
		return true;
	}

	return false;
}


export async function activate(context: vscode.ExtensionContext) {
	console.log('DevOrb extension is now active!');

	// Debug: Show environment detection
	const inDevContainer = isRunningInDevContainer();
	const environment = inDevContainer ? 'Dev Container' : 'Host';

	// Initialize DevOrb Services
	syncService = new ClaudeSyncService();
	await syncService.initialize();

	// Initialize Environment Service
	envService = new EnvironmentService(context.secrets);
	await envService.initialize();

	// Initialize Environment View Provider
	environmentViewProvider = new EnvironmentViewProvider(envService);

	// Set up callback for when remote data is loaded
	environmentViewProvider.setRemoteDataLoadedCallback(async () => {
		// Set up the auto-sync file watcher now that we have remote data
		setupFileWatcher();

		// Run auto-create missing files
		await autoCreateMissingEnvFiles();

		// Mark that remote data is now loaded
		remoteDataLoaded = true;
		console.log('✅ All initialization complete - remote data loaded and watchers set up');
	});

	// Skip initialization during startup to avoid rate limits - will be done later with delay

	// Register the tree view
	const environmentView = vscode.window.createTreeView('devOrb.environmentView', {
		treeDataProvider: environmentViewProvider,
		showCollapseAll: true
	});

	// Create status bar item for environment info
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'devOrb.showStatus';
	statusBarItem.text = `$(desktop) ${environment}`;
	statusBarItem.tooltip = `Extension running in: ${environment}`;
	updateStatusBar();
	statusBarItem.show();

	// Show initial toast for debugging
	vscode.window.showInformationMessage(`Extension loaded - Running in: ${environment}`);

	// Update token status indicator
	await updateTokenStatus();

	// If in dev container and sync enabled, perform initial sync
	if (inDevContainer) {
		const mainConfig = vscode.workspace.getConfiguration('devOrb');
		const claudeConfig = vscode.workspace.getConfiguration('devOrb.claude');
		if (mainConfig.get('enabled') && claudeConfig.get('enabled') && mainConfig.get('autoSync')) {
			// Delay initial sync to let VSCode fully load
			setTimeout(async () => {
				await vscode.commands.executeCommand('devOrb.syncNow');
			}, 5000);
		}
	}


	// DevOrb Sync commands
	let syncNow = vscode.commands.registerCommand('devOrb.syncNow', async () => {
		const mainConfig = vscode.workspace.getConfiguration('devOrb');
		const claudeConfig = vscode.workspace.getConfiguration('devOrb.claude');

		if (!mainConfig.get('enabled')) {
			const enable = await vscode.window.showInformationMessage(
				'DevOrb is disabled. Enable it first?',
				'Enable',
				'Cancel'
			);
			if (enable === 'Enable') {
				await vscode.commands.executeCommand('devOrb.openSettings');
			}
			return;
		}

		if (!claudeConfig.get('enabled')) {
			const enable = await vscode.window.showInformationMessage(
				'DevOrb Sync is disabled. Enable it first?',
				'Enable',
				'Cancel'
			);
			if (enable === 'Enable') {
				await vscode.commands.executeCommand('devOrb.openSettings');
			}
			return;
		}

		// Check authentication
		const isAuthenticated = await syncService.ensureAuthenticated();
		if (!isAuthenticated) {
			const signIn = await vscode.window.showInformationMessage(
				'Please sign in to GitHub to enable DevOrb Sync.',
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

	let showStatus = vscode.commands.registerCommand('devOrb.showStatus', () => {
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

	let openSettings = vscode.commands.registerCommand('devOrb.openSettings', async () => {
		try {
			// Open settings and search for devOrb
			await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jimseiwert.devorb');
		} catch (error) {
			try {
				// Fallback: try broader search
				await vscode.commands.executeCommand('workbench.action.openSettings', 'devOrb');
			} catch (fallbackError) {
				// Final fallback: open general settings and show info message
				await vscode.commands.executeCommand('workbench.action.openSettings');
				vscode.window.showInformationMessage('Search for "devOrb" in the settings to configure DevOrb sync options.');
			}
		}
	});

	// Environment commands
	let refreshEnvironment = vscode.commands.registerCommand('devOrb.refreshEnvironment', async () => {
		await environmentViewProvider.refresh();
	});

	let syncAllEnvironment = vscode.commands.registerCommand('devOrb.syncAllEnvironment', async () => {
		await environmentViewProvider.syncAllEnvironmentVariables();
	});

	let syncEnvironmentVariable = vscode.commands.registerCommand('devOrb.syncEnvironmentVariable', async (item) => {
		await environmentViewProvider.syncEnvironmentVariable(item);
	});

	let addRemoteSecretToLocal = vscode.commands.registerCommand('devOrb.addRemoteSecretToLocal', async (item) => {
		await environmentViewProvider.addRemoteSecretToLocal(item);
	});

	let downloadSecretToEnv = vscode.commands.registerCommand('devOrb.downloadSecretToEnv', async (item) => {
		await environmentViewProvider.downloadSecretToEnv(item);
	});

	let downloadSecretToAllEnv = vscode.commands.registerCommand('devOrb.downloadSecretToAllEnv', async (item) => {
		await environmentViewProvider.downloadSecretToAllEnv(item);
	});

	let addMissingSecretToFile = vscode.commands.registerCommand('devOrb.addMissingSecretToFile', async (item) => {
		await environmentViewProvider.addMissingSecretToFile(item);
	});

	let uploadSecretToGitHub = vscode.commands.registerCommand('devOrb.uploadSecretToGitHub', async (item) => {
		await environmentViewProvider.uploadSecretToGitHub(item);
	});

	let removeSecretFromFile = vscode.commands.registerCommand('devOrb.removeSecretFromFile', async (item) => {
		await environmentViewProvider.removeSecretFromFile(item);
	});

	let syncAllSecretsForFile = vscode.commands.registerCommand('devOrb.syncAllSecretsForFile', async (fileUri) => {
		await environmentViewProvider.syncAllSecretsForFile(fileUri);
	});

	let resolveSecretConflict = vscode.commands.registerCommand('devOrb.resolveSecretConflict', async (item) => {
		await environmentViewProvider.resolveSecretConflict(item);
	});

	let signUp1Password = vscode.commands.registerCommand('devOrb.signUp1Password', async () => {
		const signupUrl = envService.getSignupUrl();
		vscode.env.openExternal(vscode.Uri.parse(signupUrl));
	});

	let setup1Password = vscode.commands.registerCommand('devOrb.setup1Password', async () => {
		const hasToken = await envService.hasServiceAccountToken();

		if (hasToken) {
			const choice = await vscode.window.showInformationMessage(
				'1Password Service Account Token is already configured.',
				'Update Token',
				'Clear Token',
				'Open Settings',
				'Cancel'
			);

			if (choice === 'Update Token') {
				await vscode.commands.executeCommand('devOrb.setServiceAccountToken');
			} else if (choice === 'Clear Token') {
				await vscode.commands.executeCommand('devOrb.clearServiceAccountToken');
			} else if (choice === 'Open Settings') {
				await vscode.commands.executeCommand('devOrb.openSettings');
			}
		} else {
			const choice = await vscode.window.showInformationMessage(
				'To setup 1Password SDK:\n1. Create a Service Account in your 1Password account\n2. Generate a Service Account Token (starts with "ops_")\n3. Configure the token and select a vault',
				'Set Token',
				'Select Vault',
				'Open Settings',
				'Learn More'
			);

			if (choice === 'Set Token') {
				await vscode.commands.executeCommand('devOrb.setServiceAccountToken');
			} else if (choice === 'Select Vault') {
				await vscode.commands.executeCommand('devOrb.selectVault');
			} else if (choice === 'Open Settings') {
				await vscode.commands.executeCommand('devOrb.openSettings');
			} else if (choice === 'Learn More') {
				vscode.env.openExternal(vscode.Uri.parse('https://developer.1password.com/docs/service-accounts/'));
			}
		}
	});

	let setServiceAccountToken = vscode.commands.registerCommand('devOrb.setServiceAccountToken', async () => {
		const token = await vscode.window.showInputBox({
			prompt: 'Enter your 1Password Service Account Token',
			placeHolder: 'ops_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
			password: true,
			validateInput: (value) => {
				if (!value) {
					return 'Token is required';
				}
				if (!value.startsWith('ops_')) {
					return 'Service Account Token should start with "ops_"';
				}
				if (value.length < 10) {
					return 'Token appears to be too short';
				}
				return null;
			}
		});

		if (token) {
			try {
				await envService.setServiceAccountToken(token);
				await envService.initialize(); // Reinitialize with new token
				await environmentViewProvider.refresh(); // Refresh the view
				await updateTokenStatus();
				vscode.window.showInformationMessage('✅ 1Password Service Account Token saved securely!');
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to save token: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});

	let clearServiceAccountToken = vscode.commands.registerCommand('devOrb.clearServiceAccountToken', async () => {
		const confirm = await vscode.window.showWarningMessage(
			'Are you sure you want to clear the 1Password Service Account Token?',
			{ modal: true },
			'Clear Token'
		);

		if (confirm === 'Clear Token') {
			try {
				await envService.clearServiceAccountToken();
				await environmentViewProvider.refresh(); // Refresh the view
				await updateTokenStatus();
				vscode.window.showInformationMessage('✅ 1Password Service Account Token cleared');
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to clear token: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});

	let testAutoSync = vscode.commands.registerCommand('devOrb.testAutoSync', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('No workspace folder found');
			return;
		}

		// Find .env files in the workspace
		const envFiles = await vscode.workspace.findFiles('**/.env*');
		if (envFiles.length === 0) {
			vscode.window.showErrorMessage('No .env files found in workspace');
			return;
		}

		// Test auto-sync on the first .env file found
		const testFile = envFiles[0];
		vscode.window.showInformationMessage(`Testing auto-sync on: ${path.basename(testFile.fsPath)}`);
		await autoSyncFileChanges(testFile.fsPath);
	});

	let selectVault = vscode.commands.registerCommand('devOrb.selectVault', async () => {
		try {
			// Check if we have a configured token
			const hasToken = await envService.hasServiceAccountToken();
			if (!hasToken) {
				const setup = await vscode.window.showInformationMessage(
					'1Password Service Account Token is required to list vaults.',
					'Setup Token',
					'Cancel'
				);
				if (setup === 'Setup Token') {
					await vscode.commands.executeCommand('devOrb.setServiceAccountToken');
				}
				return;
			}

			// Initialize the service to ensure client is ready
			await envService.initialize();

			// Get available vaults
			const vaults = await envService.getVaults();

			if (vaults.length === 0) {
				vscode.window.showInformationMessage('No vaults found in your 1Password account. Please create a vault first.');
				return;
			}

			// Show vault selection
			const vaultItems = vaults.map(vault => ({
				label: vault.name,
				description: vault.id,
				detail: `Vault ID: ${vault.id}`
			}));

			const selected = await vscode.window.showQuickPick(vaultItems, {
				placeHolder: 'Select a vault for DevOrb environment variables',
				matchOnDescription: true
			});

			if (selected) {
				// Update the vault ID in configuration
				const config = vscode.workspace.getConfiguration('devOrb.env');
				await config.update('onePassword.vaultId', selected.description, vscode.ConfigurationTarget.Global);

				vscode.window.showInformationMessage(`✅ Selected vault: ${selected.label} (${selected.description})`);

				// Refresh the environment view
				await environmentViewProvider.refresh();
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to list vaults: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// Register all commands
	context.subscriptions.push(syncNow, showStatus, openSettings, refreshEnvironment, syncAllEnvironment, syncEnvironmentVariable, addRemoteSecretToLocal, downloadSecretToEnv, downloadSecretToAllEnv, addMissingSecretToFile, uploadSecretToGitHub, removeSecretFromFile, syncAllSecretsForFile, resolveSecretConflict, signUp1Password, setup1Password, setServiceAccountToken, clearServiceAccountToken, selectVault, testAutoSync);

	// Listen for configuration changes
	const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
		if (e.affectsConfiguration('devOrb') || e.affectsConfiguration('devOrb.claude')) {
			// Reinitialize service with new config
			syncService.dispose();
			syncService = new ClaudeSyncService();
			await syncService.initialize();
		}

		// Handle 1Password token configuration changes
		if (e.affectsConfiguration('devOrb.env.onePassword.serviceAccountToken')) {
			await handleServiceAccountTokenChange();
		}

		// Reinitialize environment service if environment config changed
		if (e.affectsConfiguration('devOrb.env')) {
			// Only process config changes after initial setup is complete
			if (!remoteDataLoaded) {
				console.log('Ignoring config change during initial setup');
				return;
			}

			// Clear any existing timeout
			if (configChangeTimeout) {
				clearTimeout(configChangeTimeout);
			}

			// Set a new timeout to refresh after 1 second of no config changes
			configChangeTimeout = setTimeout(async () => {
				await envService.initialize();
				await environmentViewProvider.refresh();
			}, 1000);
		}
	});

	// Debounced auto-sync function to prevent rapid API calls
	const debouncedAutoSync = (filePath: string) => {
		// Clear any existing timeout for this file
		const existingTimeout = autoSyncTimeouts.get(filePath);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		// Set a new timeout for this file
		const timeout = setTimeout(async () => {
			await autoSyncFileChanges(filePath);
			autoSyncTimeouts.delete(filePath);
		}, 1000);

		autoSyncTimeouts.set(filePath, timeout);
	};

	// Set up automatic file watching for .env files
	const setupFileWatcher = () => {
		const envConfig = vscode.workspace.getConfiguration('devOrb.env');
		const enabled = envConfig.get('enabled', true);
		const autoSync = envConfig.get('autoSync', true);
		const hasWorkspace = !!vscode.workspace.workspaceFolders;

		console.log('Setting up file watcher:', {
			enabled,
			autoSync,
			hasWorkspace,
			workspaceFolders: vscode.workspace.workspaceFolders?.length
		});

		if (!enabled || !autoSync || !hasWorkspace) {
			console.log('File watcher not set up due to configuration');
			return;
		}

		// Watch for .env* files in the workspace
		const fileWatcher = vscode.workspace.createFileSystemWatcher('**/.env*');
		console.log('File watcher created for pattern: **/.env*');

		// Handle file changes (content modified)
		fileWatcher.onDidChange(async (uri) => {
			console.log('File watcher detected change:', uri.fsPath);
			if (await envService.isConfigured()) {
				console.log('Scheduling debounced auto-sync for:', uri.fsPath);
				debouncedAutoSync(uri.fsPath);
			} else {
				console.log('1Password not configured, skipping auto-sync');
			}
		});

		// Handle file creation
		fileWatcher.onDidCreate(async (uri) => {
			console.log('File watcher detected creation:', uri.fsPath);
			if (await envService.isConfigured()) {
				console.log('Scheduling debounced auto-sync for new file:', uri.fsPath);
				// Add a small delay to ensure file content is fully written, then debounce
				setTimeout(() => {
					debouncedAutoSync(uri.fsPath);
				}, 500);
			} else {
				console.log('1Password not configured, skipping auto-sync for new file');
			}
		});

		// Handle file deletion
		fileWatcher.onDidDelete(async (uri) => {
			if (await envService.isConfigured()) {
				console.log('Env file deleted:', uri.fsPath);
				await autoSyncFileDeletion(uri.fsPath);
				await environmentViewProvider.refresh();
			}
		});

		context.subscriptions.push(fileWatcher);
	};

	// Auto-sync function for file changes
	const autoSyncFileChanges = async (filePath: string) => {
		try {
			console.log(`Starting auto-sync for file: ${filePath}`);

			// Get current file variables
			const currentVars = await environmentViewProvider.parseEnvFile(filePath);
			console.log(`Found ${currentVars.length} variables in file:`, currentVars.map(v => v.key));

			// Get what we know exists in 1Password for this file
			const remoteSecrets = await envService.getRemoteSecrets();
			const fileRemoteSecrets = remoteSecrets.filter(rs => rs.filePath === filePath);
			console.log(`Found ${fileRemoteSecrets.length} existing secrets in 1Password for this file:`, fileRemoteSecrets.map(rs => rs.name));

			// Sync new/updated variables
			for (const currentVar of currentVars) {
				// Check if this variable exists in 1Password
				const existingRemote = fileRemoteSecrets.find(rs => rs.name === currentVar.key);

				if (!existingRemote) {
					// New variable - sync to 1Password
					console.log(`Auto-syncing new variable: ${currentVar.key} = ${currentVar.value}`);
					try {
						await envService.syncSingleVariable(currentVar.key, currentVar.value, filePath);
						console.log(`✅ Successfully synced new variable: ${currentVar.key}`);
					} catch (error) {
						console.error(`❌ Failed to sync new variable ${currentVar.key}:`, error);
						vscode.window.showErrorMessage(`Failed to auto-sync ${currentVar.key}: ${error instanceof Error ? error.message : String(error)}`);
					}
				} else {
					// Check if value changed
					const remoteValue = await envService.getSecretValue(existingRemote.itemId);
					if (remoteValue !== currentVar.value) {
						// Value changed - update 1Password
						console.log(`Auto-syncing updated variable: ${currentVar.key} (${remoteValue} -> ${currentVar.value})`);
						try {
							await envService.updateSecretValue(existingRemote.itemId, currentVar.value);
							console.log(`✅ Successfully updated variable: ${currentVar.key}`);
						} catch (error) {
							console.error(`❌ Failed to update variable ${currentVar.key}:`, error);
							vscode.window.showErrorMessage(`Failed to auto-sync ${currentVar.key}: ${error instanceof Error ? error.message : String(error)}`);
						}
					} else {
						console.log(`Variable ${currentVar.key} unchanged, skipping`);
					}
				}
			}

			// Check for deleted variables
			for (const remoteSecret of fileRemoteSecrets) {
				const currentVar = currentVars.find(cv => cv.key === remoteSecret.name);
				if (!currentVar) {
					// Variable was deleted from file - delete from 1Password
					console.log(`Auto-deleting removed variable: ${remoteSecret.name}`);
					try {
						await envService.deleteSecret(remoteSecret.name);
						console.log(`✅ Successfully deleted variable: ${remoteSecret.name}`);
					} catch (error) {
						console.error(`❌ Failed to delete variable ${remoteSecret.name}:`, error);
					}
				}
			}

			// Refresh the view
			await environmentViewProvider.refresh();
			console.log(`Auto-sync completed for: ${filePath}`);

		} catch (error) {
			console.error('Auto-sync failed:', error);
			vscode.window.showErrorMessage(`Auto-sync failed for ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// Auto-sync function for file deletion
	const autoSyncFileDeletion = async (filePath: string) => {
		try {
			// Get all secrets that were for this file
			const remoteSecrets = await envService.getRemoteSecrets();
			const fileRemoteSecrets = remoteSecrets.filter(rs => rs.filePath === filePath);

			// Delete all secrets for this file
			for (const remoteSecret of fileRemoteSecrets) {
				console.log(`Auto-deleting secret for deleted file: ${remoteSecret.name}`);
				await envService.deleteSecret(remoteSecret.name);
			}

		} catch (error) {
			console.error('Auto-sync file deletion failed:', error);
		}
	};

	// Initialize environment view (local data only) after startup delay
	setTimeout(async () => {
		console.log('Performing delayed environment view initialization (local data only)...');
		try {
			await environmentViewProvider.initialize();
		} catch (error) {
			console.error('Environment view initialization failed:', error);
		}
	}, 1000);

	// Load remote data and set up watchers after longer delay to avoid rate limits
	setTimeout(async () => {
		console.log('Loading remote data and setting up watchers...');
		try {
			await environmentViewProvider.loadRemoteDataAndSetupWatchers();
		} catch (error) {
			console.error('Failed to load remote data:', error);
		}
	}, 5000);

	// File watcher and auto-create will be set up after remote data is loaded (in loadRemoteDataAndSetupWatchers)

	// Auto-create missing env files from 1Password secrets (disabled during startup to avoid rate limits)
	const autoCreateMissingEnvFiles = async () => {
		const envConfig = vscode.workspace.getConfiguration('devOrb.env');
		if (!await envService.isConfigured() ||
			!vscode.workspace.workspaceFolders ||
			!envConfig.get('autoCreateFiles', true)) {
			return;
		}

		try {
			// Reuse the already-loaded remote secrets instead of making another API call
			const remoteSecrets = environmentViewProvider.getRemoteSecrets();
			if (remoteSecrets.length === 0) {
				return;
			}

			// Group secrets by file path
			const secretsByFile = new Map<string, any[]>();
			for (const secret of remoteSecrets) {
				if (!secretsByFile.has(secret.filePath)) {
					secretsByFile.set(secret.filePath, []);
				}
				secretsByFile.get(secret.filePath)!.push(secret);
			}

			// Check each file path
			for (const [filePath, secrets] of secretsByFile) {
				const fileUri = vscode.Uri.file(filePath);

				try {
					// Check if file exists
					await vscode.workspace.fs.stat(fileUri);
				} catch {
					// File doesn't exist - create it with secrets from 1Password
					console.log(`Auto-creating missing env file: ${filePath}`);
					await createEnvFileFromSecrets(filePath, secrets);
				}
			}
		} catch (error) {
			console.error('Auto-create missing env files failed:', error);
		}
	};

	// Helper function to create env file from 1Password secrets
	const createEnvFileFromSecrets = async (filePath: string, secrets: any[]) => {
		try {
			let content = `# Auto-generated from 1Password\n# File: ${path.basename(filePath)}\n\n`;

			for (const secret of secrets) {
				const value = await envService.getSecretValue(secret.itemId);
				if (value !== null) {
					content += `${secret.name}=${value}\n`;
				}
			}

			// Create directory if it doesn't exist
			const dirPath = path.dirname(filePath);
			const dirUri = vscode.Uri.file(dirPath);
			try {
				await vscode.workspace.fs.createDirectory(dirUri);
			} catch {
				// Directory might already exist
			}

			// Write the file
			const fileUri = vscode.Uri.file(filePath);
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));

			vscode.window.showInformationMessage(`✅ Created ${path.basename(filePath)} with ${secrets.length} variables from 1Password`);
		} catch (error) {
			console.error(`Failed to create env file ${filePath}:`, error);
		}
	};

	// Auto-create will be triggered by the callback after remote data is loaded

	async function updateTokenStatus() {
		try {
			const hasToken = await envService.hasServiceAccountToken();
			const config = vscode.workspace.getConfiguration('devOrb.env');
			const status = hasToken ? '✅ Token configured securely' : '❌ No token configured';

			await config.update('onePassword.tokenStatus', status, vscode.ConfigurationTarget.Global);
		} catch (error) {
			console.error('Failed to update token status:', error);
		}
	}

	async function handleServiceAccountTokenChange() {
		const config = vscode.workspace.getConfiguration('devOrb.env');
		const tokenFromSettings = config.get<string>('onePassword.serviceAccountToken', '');

		if (tokenFromSettings && tokenFromSettings.trim() !== '') {
			try {
				// Validate the token format
				if (!tokenFromSettings.startsWith('ops_')) {
					vscode.window.showErrorMessage('Invalid Service Account Token format. Token should start with "ops_"');
					// Clear the invalid token from settings
					await config.update('onePassword.serviceAccountToken', '', vscode.ConfigurationTarget.Global);
					return;
				}

				// Store the token securely
				await envService.setServiceAccountToken(tokenFromSettings);

				// Clear the token from the plaintext settings immediately
				await config.update('onePassword.serviceAccountToken', '', vscode.ConfigurationTarget.Global);

				// Reinitialize services with the new token
				await envService.initialize();

				// Check if vault ID is empty and create DevOrb vault
				const envConfig = vscode.workspace.getConfiguration('devOrb.env');
				const vaultId = envConfig.get<string>('onePassword.vaultId', '');

				if (!vaultId || vaultId.trim() === '') {
					try {
						const foundVaultId = await envService.ensureDevOrbVault();
						vscode.window.showInformationMessage(`🔐 Token saved securely and found DevOrb vault! Vault ID: ${foundVaultId}`);
					} catch (error) {
						console.error('Failed to find DevOrb vault:', error);
						const message = error instanceof Error ? error.message : String(error);
						if (message.includes('DevOrb vault not found')) {
							vscode.window.showWarningMessage('🔐 Token saved securely! Please create a vault named "DevOrb" in 1Password or configure a vault ID in settings.');
						} else {
							vscode.window.showInformationMessage('🔐 Token saved securely! Please configure vault ID in settings.');
						}
					}
				} else {
					vscode.window.showInformationMessage('🔐 1Password Service Account Token saved securely!');
				}

				await environmentViewProvider.refresh();
				await updateTokenStatus();
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to save token: ${error instanceof Error ? error.message : String(error)}`);
				// Clear the invalid token from settings
				await config.update('onePassword.serviceAccountToken', '', vscode.ConfigurationTarget.Global);
			}
		}
	}

	context.subscriptions.push(configWatcher, statusBarItem, environmentView);

	// Function to update status bar
	function updateStatusBar() {
		const mainConfig = vscode.workspace.getConfiguration('devOrb');
		const claudeConfig = vscode.workspace.getConfiguration('devOrb.claude');
		if (!mainConfig.get('enabled') || !claudeConfig.get('enabled')) {
			statusBarItem.hide();
			return;
		}

		const status = syncService.getSyncStatus();
		const lastSync = status.lastSync ? new Date(status.lastSync).toLocaleString() : 'Never';

		if (status.issyncing) {
			statusBarItem.text = "$(sync~spin) DevOrb Sync: Syncing...";
			statusBarItem.tooltip = "DevOrb configuration sync in progress";
		} else if (status.errors.length > 0) {
			statusBarItem.text = "$(error) DevOrb Sync: Error";
			statusBarItem.tooltip = `DevOrb Sync Error: ${status.errors[0]}`;
		} else {
			statusBarItem.text = "$(cloud) DevOrb Sync";
			statusBarItem.tooltip = `DevOrb Sync - Last sync: ${lastSync}`;
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
	if (envService) {
		envService.dispose();
	}
	if (environmentViewProvider) {
		environmentViewProvider.dispose();
	}

	// Clean up any pending timeouts
	if (configChangeTimeout) {
		clearTimeout(configChangeTimeout);
	}

	for (const timeout of autoSyncTimeouts.values()) {
		clearTimeout(timeout);
	}
	autoSyncTimeouts.clear();
}