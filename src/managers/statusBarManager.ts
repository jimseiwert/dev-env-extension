import * as vscode from 'vscode';
import { EnvironmentService } from '../services';

export enum DevOrbStatus {
  DISABLED = 'disabled',
  NOT_CONFIGURED = 'not_configured',
  MISSING_TOKEN = 'missing_token',
  MISSING_VAULT = 'missing_vault',
  READY = 'ready',
  SYNCING = 'syncing',
  ERROR = 'error'
}

export interface StatusInfo {
  status: DevOrbStatus;
  message: string;
  tooltip: string;
  icon: string;
}

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private updateInterval?: NodeJS.Timeout;
  private currentStatus: DevOrbStatus = DevOrbStatus.NOT_CONFIGURED;

  constructor(private envService: EnvironmentService) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    // Start with default command, will be updated based on status
    this.statusBarItem.command = 'devOrb.refreshEnvironment';
  }

  public async initialize(): Promise<void> {
    await this.updateStatusBar();
    this.statusBarItem.show();
  }

  public async updateStatusBar(): Promise<void> {
    try {
      const statusInfo = await this.getStatusInfo();
      this.currentStatus = statusInfo.status;

      this.statusBarItem.text = `$(cloud) DevOrb: ${statusInfo.message}`;
      this.statusBarItem.tooltip = statusInfo.tooltip;
      this.statusBarItem.backgroundColor = this.getStatusColor(statusInfo.status);
      this.statusBarItem.command = this.getCommandForStatus(statusInfo.status);

      this.statusBarItem.show();
    } catch (error) {
      console.error('Failed to update status bar:', error);
      this.currentStatus = DevOrbStatus.ERROR;
      this.statusBarItem.text = '$(error) DevOrb: Error';
      this.statusBarItem.tooltip = 'DevOrb status update failed';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.statusBarItem.command = 'devOrb.refreshEnvironment';
    }
  }

  private async getStatusInfo(): Promise<StatusInfo> {
    const config = vscode.workspace.getConfiguration('devOrb');
    const envConfig = vscode.workspace.getConfiguration('devOrb.env');

    // Check if DevOrb is enabled
    if (!config.get('enabled', true)) {
      return {
        status: DevOrbStatus.DISABLED,
        message: 'Disabled',
        tooltip: 'DevOrb is disabled in settings. Click to open settings.',
        icon: '$(circle-slash)'
      };
    }

    // Check if environment syncing is enabled
    if (!envConfig.get('enabled', true)) {
      return {
        status: DevOrbStatus.DISABLED,
        message: 'Env Disabled',
        tooltip: 'DevOrb environment syncing is disabled in settings. Click to open settings.',
        icon: '$(circle-slash)'
      };
    }

    // Check if 1Password token is configured
    const hasToken = await this.envService.hasServiceAccountToken();
    if (!hasToken) {
      return {
        status: DevOrbStatus.MISSING_TOKEN,
        message: 'No Token',
        tooltip: 'DevOrb: 1Password Service Account Token not configured. Click to set token.',
        icon: '$(key)'
      };
    }

    // Check if vault is configured
    const vaultId = envConfig.get<string>('onePassword.vaultId', '');
    if (!vaultId || vaultId.trim() === '') {
      return {
        status: DevOrbStatus.MISSING_VAULT,
        message: 'No Vault',
        tooltip: 'DevOrb: 1Password vault not selected. Click to select vault.',
        icon: '$(database)'
      };
    }

    // Check if service is properly configured
    try {
      const isConfigured = await this.envService.isConfigured();
      if (!isConfigured) {
        return {
          status: DevOrbStatus.NOT_CONFIGURED,
          message: 'Not Configured',
          tooltip: 'DevOrb: Service not properly configured. Click to setup 1Password.',
          icon: '$(gear)'
        };
      }
    } catch (error) {
      return {
        status: DevOrbStatus.ERROR,
        message: 'Error',
        tooltip: `DevOrb: Configuration error - ${error instanceof Error ? error.message : String(error)}. Click to setup 1Password.`,
        icon: '$(error)'
      };
    }

    // Check if auto-sync is enabled
    const autoSync = config.get('autoSync', true) && envConfig.get('autoSync', true);
    if (!autoSync) {
      return {
        status: DevOrbStatus.READY,
        message: 'Ready (Manual)',
        tooltip: 'DevOrb: Ready for manual syncing (auto-sync disabled)',
        icon: '$(cloud)'
      };
    }

    // All good - ready for auto sync
    return {
      status: DevOrbStatus.READY,
      message: 'Ready',
      tooltip: 'DevOrb: Ready and monitoring environment files for changes',
      icon: '$(cloud)'
    };
  }

  private getCommandForStatus(status: DevOrbStatus): string {
    switch (status) {
      case DevOrbStatus.MISSING_TOKEN:
        return 'devOrb.setServiceAccountToken';
      case DevOrbStatus.MISSING_VAULT:
        return 'devOrb.selectVault';
      case DevOrbStatus.NOT_CONFIGURED:
      case DevOrbStatus.ERROR:
        return 'devOrb.setup1Password';
      case DevOrbStatus.DISABLED:
        // Open DevOrb settings
        return 'devOrb.openSettings';
      case DevOrbStatus.READY:
      case DevOrbStatus.SYNCING:
      default:
        return 'devOrb.refreshEnvironment';
    }
  }

  private getStatusColor(status: DevOrbStatus): vscode.ThemeColor | undefined {
    switch (status) {
      case DevOrbStatus.ERROR:
        return new vscode.ThemeColor('statusBarItem.errorBackground');
      case DevOrbStatus.MISSING_TOKEN:
      case DevOrbStatus.MISSING_VAULT:
      case DevOrbStatus.NOT_CONFIGURED:
        return new vscode.ThemeColor('statusBarItem.warningBackground');
      case DevOrbStatus.DISABLED:
        return new vscode.ThemeColor('statusBarItem.prominentBackground');
      case DevOrbStatus.READY:
      case DevOrbStatus.SYNCING:
      default:
        return undefined; // Use default background
    }
  }

  public async showSyncingStatus(): Promise<void> {
    this.statusBarItem.text = '$(sync~spin) DevOrb: Syncing...';
    this.statusBarItem.tooltip = 'DevOrb: Syncing environment files with 1Password';
    this.statusBarItem.backgroundColor = undefined;
  }

  public async hideSyncingStatus(): Promise<void> {
    await this.updateStatusBar();
  }

  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.statusBarItem.dispose();
  }
}