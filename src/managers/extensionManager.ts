import * as vscode from 'vscode';
import { EnvironmentService } from '../services';
import { CommandRegistry } from '../commands/commandRegistry';
import { AutoSyncService } from '../services/autoSyncService';
import { StatusBarManager } from './statusBarManager';
import { FileDecorator } from '../decorators/fileDecorator';

export class ExtensionManager {
  private envService: EnvironmentService;
  private commandRegistry: CommandRegistry;
  private autoSyncService: AutoSyncService;
  private statusBarManager: StatusBarManager;
  private fileDecorator: FileDecorator;
  private configChangeTimeout?: NodeJS.Timeout;

  constructor(private context: vscode.ExtensionContext) {
    this.envService = new EnvironmentService(context.secrets);
    this.statusBarManager = new StatusBarManager(this.envService);
    this.fileDecorator = new FileDecorator(this.envService);
    this.autoSyncService = new AutoSyncService(this.envService, this.fileDecorator, this.statusBarManager);
    this.commandRegistry = new CommandRegistry(
      this.envService,
      this.autoSyncService,
      this.statusBarManager,
      this.fileDecorator
    );
  }

  public async activate(): Promise<void> {
    console.log('DevOrb extension is now active!');

    await this.initializeServices();
    this.setupUI();
    this.registerCommands();
    await this.initializeStatusBar();
    this.setupConfigurationWatchers();
    this.scheduleDelayedInitialization();
  }

  private async initializeServices(): Promise<void> {
    // Initialize DevOrb Services
    await this.envService.initialize();
  }

  private setupUI(): Promise<void> {
    const environment = this.isRunningInDevContainer() ? 'Dev Container' : 'Host';

    // Register file decorator for .env files
    this.context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this.fileDecorator)
    );

    // Show initial toast for debugging
    vscode.window.showInformationMessage(`DevOrb is running in: ${environment}`);

    return Promise.resolve();
  }

  private registerCommands(): void {
    const commands = this.commandRegistry.registerAllCommands();
    this.context.subscriptions.push(...commands);
  }

  private async initializeStatusBar(): Promise<void> {
    await this.statusBarManager.initialize();
    this.context.subscriptions.push(this.statusBarManager);
  }

  private setupConfigurationWatchers(): void {
    const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
      await this.handleConfigurationChange(e);
    });

    // Add workspace folder change watcher to refresh when switching workspaces
    const workspaceFolderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      console.log('🔄 Workspace folders changed, refreshing DevOrb sync status...');
      await this.handleWorkspaceChange();
    });

    // Listen to window state changes for potential refresh scenarios
    const windowStateWatcher = vscode.window.onDidChangeWindowState(async (windowState) => {
      if (windowState.focused) {
        console.log('🔍 Window gained focus, checking for potential refresh...');
        await this.handleWindowFocus();
      }
    });

    this.context.subscriptions.push(configWatcher, workspaceFolderWatcher, windowStateWatcher);
  }

  private async handleConfigurationChange(e: vscode.ConfigurationChangeEvent): Promise<void> {
    if (e.affectsConfiguration('devOrb.env')) {
      // Reinitialize environment service if needed
      await this.envService.initialize();
    }

    if (e.affectsConfiguration('devOrb.env.onePassword.serviceAccountToken')) {
      await this.handleServiceAccountTokenChange();
    }

    if (e.affectsConfiguration('devOrb.env') || e.affectsConfiguration('devOrb')) {
      this.handleEnvironmentConfigChange();
    }
  }

  private handleEnvironmentConfigChange(): void {
    if (this.configChangeTimeout) {
      clearTimeout(this.configChangeTimeout);
    }

    this.configChangeTimeout = setTimeout(async () => {
      await this.envService.initialize();
      this.fileDecorator.refreshAll();
      await this.statusBarManager.updateStatusBar();
    }, 1000);
  }

  private async handleServiceAccountTokenChange(): Promise<void> {
    const config = vscode.workspace.getConfiguration('devOrb.env');
    const tokenFromSettings = config.get<string>('onePassword.serviceAccountToken', '');

    if (tokenFromSettings && tokenFromSettings.trim() !== '') {
      try {
        if (!tokenFromSettings.startsWith('ops_')) {
          vscode.window.showErrorMessage('Invalid Service Account Token format. Token should start with "ops_"');
          await config.update('onePassword.serviceAccountToken', '', vscode.ConfigurationTarget.Global);
          return;
        }

        await this.envService.setServiceAccountToken(tokenFromSettings);
        await config.update('onePassword.serviceAccountToken', '', vscode.ConfigurationTarget.Global);
        await this.envService.initialize();

        const envConfig = vscode.workspace.getConfiguration('devOrb.env');
        const vaultId = envConfig.get<string>('onePassword.vaultId', '');

        if (!vaultId || vaultId.trim() === '') {
          try {
            const foundVaultId = await this.envService.ensureDevOrbVault();
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

        this.fileDecorator.refreshAll();
        await this.statusBarManager.updateStatusBar();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to save token: ${error instanceof Error ? error.message : String(error)}`);
        await config.update('onePassword.serviceAccountToken', '', vscode.ConfigurationTarget.Global);
      }
    }
  }

  private scheduleDelayedInitialization(): void {
    // Initialize file decorations after startup delay
    setTimeout(async () => {
      console.log('Performing delayed file decorator initialization...');
      try {
        this.fileDecorator.refreshAll();
      } catch (error) {
        console.error('File decorator initialization failed:', error);
      }
    }, 1000);

    // Set up auto sync with longer delay to avoid overwhelming API
    setTimeout(async () => {
      console.log('Setting up auto sync...');
      try {
        const isConfigured = await this.envService.isConfigured();
        if (isConfigured) {
          await this.autoSyncService.autoCreateMissingEnvFiles();
        } else {
          console.log('DevOrb not configured, skipping auto-sync');
        }
      } catch (error) {
        console.error('Failed to setup auto sync:', error);
        // This is non-critical - extension should continue working
      }
    }, 8000); // Increased to 8 seconds to give network/API more time
  }

  private async handleWorkspaceChange(): Promise<void> {
    try {
      // Reinitialize services for new workspace
      await this.envService.initialize();

      // Refresh file decorations
      this.fileDecorator.refreshAll();

      // Update status bar
      await this.statusBarManager.updateStatusBar();

      // If configured, trigger auto-sync after a short delay
      setTimeout(async () => {
        try {
          const isConfigured = await this.envService.isConfigured();
          if (isConfigured) {
            await this.autoSyncService.autoCreateMissingEnvFiles();
          }
        } catch (error) {
          console.error('Auto-sync after workspace change failed:', error);
        }
      }, 2000);

    } catch (error) {
      console.error('Workspace change handling failed:', error);
    }
  }

  private async handleWindowFocus(): Promise<void> {
    // Debounce rapid focus events
    if (this.configChangeTimeout) {
      clearTimeout(this.configChangeTimeout);
    }

    this.configChangeTimeout = setTimeout(async () => {
      try {
        // Only refresh decorations - don't trigger full sync on every focus
        this.fileDecorator.refreshAll();
        await this.statusBarManager.updateStatusBar();
      } catch (error) {
        console.debug('Window focus handling failed:', error);
      }
    }, 1000);
  }

  private isRunningInDevContainer(): boolean {
    if (vscode.env.remoteName === 'dev-container') {
      return true;
    }

    if (process.env.REMOTE_CONTAINERS === 'true' || process.env.CODESPACES === 'true') {
      return true;
    }

    return false;
  }

  public dispose(): void {
    if (this.configChangeTimeout) {
      clearTimeout(this.configChangeTimeout);
    }

    this.envService?.dispose();
    this.autoSyncService?.dispose();
    this.statusBarManager?.dispose();
    this.fileDecorator?.dispose();
  }
}