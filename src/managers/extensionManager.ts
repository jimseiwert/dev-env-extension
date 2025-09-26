import * as vscode from 'vscode';
import { EnvironmentService } from '../services';
import { EnvironmentViewProvider } from '../providers';
import { CommandRegistry } from '../commands/commandRegistry';
import { AutoSyncService } from '../services/autoSyncService';
import { StatusBarManager } from './statusBarManager';

export class ExtensionManager {
  private envService: EnvironmentService;
  private environmentViewProvider: EnvironmentViewProvider;
  private commandRegistry: CommandRegistry;
  private autoSyncService: AutoSyncService;
  private statusBarManager: StatusBarManager;
  private configChangeTimeout?: NodeJS.Timeout;

  constructor(private context: vscode.ExtensionContext) {
    this.envService = new EnvironmentService(context.secrets);
    this.environmentViewProvider = new EnvironmentViewProvider(this.envService);
    this.statusBarManager = new StatusBarManager(this.envService);
    this.autoSyncService = new AutoSyncService(this.envService, this.environmentViewProvider, this.statusBarManager);
    this.commandRegistry = new CommandRegistry(
      this.envService,
      this.environmentViewProvider,
      this.autoSyncService,
      this.statusBarManager
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

    // Set up callback for when remote data is loaded
    this.environmentViewProvider.setRemoteDataLoadedCallback(async () => {
      await this.onRemoteDataLoaded();
    });
  }

  private setupUI(): Promise<void> {
    const environment = this.isRunningInDevContainer() ? 'Dev Container' : 'Host';

    // Register the tree view
    const environmentView = vscode.window.createTreeView('devOrb.environmentView', {
      treeDataProvider: this.environmentViewProvider,
      showCollapseAll: true
    });


    // Show initial toast for debugging
    vscode.window.showInformationMessage(`DevOrb is running in: ${environment}`);

    // Subscribe to disposables
    this.context.subscriptions.push(environmentView);

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

    this.context.subscriptions.push(configWatcher);
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
      await this.environmentViewProvider.refresh();
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

        await this.environmentViewProvider.refresh();
        await this.statusBarManager.updateStatusBar();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to save token: ${error instanceof Error ? error.message : String(error)}`);
        await config.update('onePassword.serviceAccountToken', '', vscode.ConfigurationTarget.Global);
      }
    }
  }

  private async onRemoteDataLoaded(): Promise<void> {
    // AutoSyncService handles file watching internally
    await this.autoSyncService.autoCreateMissingEnvFiles();
    console.log('✅ All initialization complete - remote data loaded and watchers set up');
  }

  private scheduleDelayedInitialization(): void {
    // Initialize environment view (local data only) after startup delay
    setTimeout(async () => {
      console.log('Performing delayed environment view initialization (local data only)...');
      try {
        await this.environmentViewProvider.initialize();
      } catch (error) {
        console.error('Environment view initialization failed:', error);
      }
    }, 1000);

    // Load remote data and set up watchers after longer delay to avoid rate limits
    setTimeout(async () => {
      console.log('Loading remote data and setting up watchers...');
      try {
        await this.environmentViewProvider.loadRemoteDataAndSetupWatchers();
      } catch (error) {
        console.error('Failed to load remote data:', error);
      }
    }, 5000);

    // Schedule initial sync if in dev container
    if (this.isRunningInDevContainer()) {
      const mainConfig = vscode.workspace.getConfiguration('devOrb');
      const claudeConfig = vscode.workspace.getConfiguration('devOrb.claude');
      if (mainConfig.get('enabled') && claudeConfig.get('enabled') && mainConfig.get('autoSync')) {
        setTimeout(async () => {
          await vscode.commands.executeCommand('devOrb.syncNow');
        }, 5000);
      }
    }
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
    this.environmentViewProvider?.dispose();
    this.autoSyncService?.dispose();
    this.statusBarManager?.dispose();
  }
}