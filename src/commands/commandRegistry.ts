import * as vscode from 'vscode';
import * as path from 'path';
import { EnvironmentService } from '../services';
import { EnvironmentViewProvider } from '../providers';
import { AutoSyncService } from '../services/autoSyncService';
import { StatusBarManager } from '../managers/statusBarManager';

export class CommandRegistry {
  constructor(
    private envService: EnvironmentService,
    private environmentViewProvider: EnvironmentViewProvider,
    private autoSyncService: AutoSyncService,
    private statusBarManager?: StatusBarManager
  ) {}

  public registerAllCommands(): vscode.Disposable[] {
    const commands: vscode.Disposable[] = [];

    // Environment commands
    commands.push(...this.registerEnvironmentCommands());

    // 1Password setup commands
    commands.push(...this.register1PasswordCommands());

    return commands;
  }


  private registerEnvironmentCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('devOrb.refreshEnvironment', async () => {
        await this.environmentViewProvider.refresh();
      }),

      vscode.commands.registerCommand('devOrb.syncAllEnvironment', async () => {
        await this.handleSyncAllEnvFiles();
      }),

      vscode.commands.registerCommand('devOrb.syncEnvironmentFile', async (item) => {
        await this.handleSyncEnvironmentFile(item);
      }),

      vscode.commands.registerCommand('devOrb.createMissingEnvFiles', async () => {
        await this.handleCreateMissingEnvFiles();
      }),

      vscode.commands.registerCommand('devOrb.testAutoSync', async () => {
        await this.handleTestAutoSync();
      })
    ];
  }

  private register1PasswordCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('devOrb.signUp1Password', async () => {
        const signupUrl = this.envService.getSignupUrl();
        vscode.env.openExternal(vscode.Uri.parse(signupUrl));
      }),

      vscode.commands.registerCommand('devOrb.setup1Password', async () => {
        await this.handleSetup1Password();
      }),

      vscode.commands.registerCommand('devOrb.setServiceAccountToken', async () => {
        await this.handleSetServiceAccountToken();
      }),

      vscode.commands.registerCommand('devOrb.clearServiceAccountToken', async () => {
        await this.handleClearServiceAccountToken();
      }),

      vscode.commands.registerCommand('devOrb.selectVault', async () => {
        await this.handleSelectVault();
      }),

      vscode.commands.registerCommand('devOrb.openSettings', async () => {
        await this.handleOpenSettings();
      })
    ];
  }


  private async handleSetup1Password(): Promise<void> {
    const hasToken = await this.envService.hasServiceAccountToken();

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
  }

  private async handleSetServiceAccountToken(): Promise<void> {
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
        await this.envService.setServiceAccountToken(token);
        await this.envService.initialize();
        await this.environmentViewProvider.refresh();
        vscode.window.showInformationMessage('✅ 1Password Service Account Token saved securely!');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to save token: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async handleClearServiceAccountToken(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Are you sure you want to clear the 1Password Service Account Token?',
      { modal: true },
      'Clear Token'
    );

    if (confirm === 'Clear Token') {
      try {
        await this.envService.clearServiceAccountToken();
        await this.environmentViewProvider.refresh();
        vscode.window.showInformationMessage('✅ 1Password Service Account Token cleared');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to clear token: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async handleSelectVault(): Promise<void> {
    try {
      const hasToken = await this.envService.hasServiceAccountToken();
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

      await this.envService.initialize();
      const vaults = await this.envService.getVaults();

      if (vaults.length === 0) {
        vscode.window.showInformationMessage('No vaults found in your 1Password account. Please create a vault first.');
        return;
      }

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
        const config = vscode.workspace.getConfiguration('devOrb.env');
        await config.update('onePassword.vaultId', selected.description, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`✅ Selected vault: ${selected.label} (${selected.description})`);
        await this.environmentViewProvider.refresh();
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to list vaults: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleOpenSettings(): Promise<void> {
    // Open VS Code settings focused on DevOrb settings
    await vscode.commands.executeCommand('workbench.action.openSettings', 'devOrb');
  }

  private async handleTestAutoSync(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const envFiles = await vscode.workspace.findFiles('**/.env*');
    if (envFiles.length === 0) {
      vscode.window.showErrorMessage('No .env files found in workspace');
      return;
    }

    const testFile = envFiles[0];
    vscode.window.showInformationMessage(`Testing auto-sync on: ${path.basename(testFile.fsPath)}`);
    this.autoSyncService.scheduleAutoSync(testFile.fsPath);
  }

  private async handleSyncAllEnvFiles(): Promise<void> {
    const isConfigured = await this.envService.isConfigured();
    if (!isConfigured) {
      vscode.window.showErrorMessage('1Password not configured. Please configure 1Password first.');
      return;
    }

    try {
      await this.statusBarManager?.showSyncingStatus();

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Syncing all .env files with 1Password...',
        cancellable: false
      }, async () => {
        await this.envService.syncAllEnvFiles();
      });

      vscode.window.showInformationMessage('✅ All .env files synced with 1Password successfully!');
      await this.environmentViewProvider.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to sync .env files: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.statusBarManager?.hideSyncingStatus();
    }
  }

  private async handleSyncEnvironmentFile(item: any): Promise<void> {
    const filePath = item?.resourceUri?.fsPath;
    if (!filePath) {
      vscode.window.showErrorMessage('Invalid file data.');
      return;
    }

    await this.handleSyncSingleEnvFile(filePath);
  }

  private async handleSyncSingleEnvFile(filePath: string): Promise<void> {
    const isConfigured = await this.envService.isConfigured();
    if (!isConfigured) {
      vscode.window.showErrorMessage('1Password not configured. Please configure 1Password first.');
      return;
    }

    try {
      await this.statusBarManager?.showSyncingStatus();

      const fileName = path.basename(filePath);
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Syncing ${fileName} to 1Password...`,
        cancellable: false
      }, async () => {
        await this.envService.syncSingleEnvFile(filePath);
      });

      vscode.window.showInformationMessage(`✅ ${fileName} synced to 1Password successfully!`);
      await this.environmentViewProvider.refresh();
    } catch (error) {
      const fileName = path.basename(filePath);
      vscode.window.showErrorMessage(`Failed to sync ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.statusBarManager?.hideSyncingStatus();
    }
  }

  private async handleCreateMissingEnvFiles(): Promise<void> {
    const isConfigured = await this.envService.isConfigured();
    if (!isConfigured) {
      vscode.window.showErrorMessage('1Password not configured. Please configure 1Password first.');
      return;
    }

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Creating missing .env files from 1Password...',
        cancellable: false
      }, async () => {
        await this.autoSyncService.autoCreateMissingEnvFiles();
      });

      vscode.window.showInformationMessage('✅ Missing .env files created from 1Password!');
      await this.environmentViewProvider.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create missing files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}