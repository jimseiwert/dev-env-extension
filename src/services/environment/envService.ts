import * as vscode from 'vscode';
import * as path from 'path';
import { OnePasswordService } from './onePasswordService';
import { EnvFileSyncService } from './envFileSyncService';
import { Item } from '@1password/sdk';
import { EnvVariable, RemoteSecret, SyncedEnvFile } from '../../types';

export class EnvironmentService {
  private onePasswordService: OnePasswordService;
  private fileSyncService: EnvFileSyncService;

  constructor(secretStorage: vscode.SecretStorage) {
    this.onePasswordService = new OnePasswordService(secretStorage);
    this.fileSyncService = new EnvFileSyncService(this.onePasswordService);
  }

  public async initialize(): Promise<void> {
    await this.onePasswordService.initialize();
    await this.updateTokenStatusSetting();
  }

  public async isConfigured(): Promise<boolean> {
    return this.onePasswordService.isConfigured();
  }

  // File-based sync methods (new approach)
  public async syncAllEnvFiles(): Promise<void> {
    console.log('🔄 Starting file-based sync for all .env files...');
    await this.fileSyncService.syncAllFiles();
  }

  public async syncSingleEnvFile(filePath: string): Promise<void> {
    console.log(`🔄 Syncing single file: ${filePath}`);
    await this.fileSyncService.syncFileToRemote(filePath);
  }

  public async createLocalFileFromRemote(remoteFile: SyncedEnvFile): Promise<void> {
    await this.fileSyncService.createFileFromRemote(remoteFile);
  }

  public async getRemoteEnvFiles(): Promise<SyncedEnvFile[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const repoName = this.getRepoName(workspaceFolder.uri.fsPath);
    return await this.onePasswordService.getEnvFilesForRepo(repoName);
  }

  // Legacy methods for backward compatibility (will be phased out)
  public async syncEnvFile(filePath: string): Promise<void> {
    console.warn('⚠️ syncEnvFile is deprecated, use syncSingleEnvFile instead');
    await this.syncSingleEnvFile(filePath);
  }

  public async syncSingleVariable(key: string, value: string, filePath: string): Promise<void> {
    console.warn('⚠️ Individual variable sync is deprecated, use file-based sync instead');
    // For now, redirect to file sync
    await this.syncSingleEnvFile(filePath);
  }

  public async parseEnvFile(filePath: string): Promise<EnvVariable[]> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);
      const content = document.getText();
      return this.parseEnvContent(content);
    } catch (error) {
      console.error(`Error parsing env file ${filePath}:`, error);
      return [];
    }
  }

  public parseEnvContent(content: string): EnvVariable[] {
    const lines = content.split('\n');
    const variables: EnvVariable[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex > 0) {
          const key = trimmed.substring(0, equalsIndex).trim();
          const value = trimmed.substring(equalsIndex + 1).trim();

          // Remove surrounding quotes if present
          const cleanValue = value.replace(/^["'](.*)["']$/, '$1');

          variables.push({
            key,
            value: cleanValue
          });
        }
      }
    }

    return variables;
  }

  // Utility methods
  private getRepoName(workspacePath: string): string {
    try {
      const gitConfigPath = path.join(workspacePath, '.git', 'config');
      if (require('fs').existsSync(gitConfigPath)) {
        const gitConfig = require('fs').readFileSync(gitConfigPath, 'utf8');
        const match = gitConfig.match(/url = .*[\/:]([^\/]+)\.git/);
        if (match) {
          return match[1];
        }
      }
    } catch (error) {
      console.warn('Could not read git config:', error);
    }

    return path.basename(workspacePath);
  }

  // 1Password service delegation methods
  public async hasServiceAccountToken(): Promise<boolean> {
    return this.onePasswordService.hasServiceAccountToken();
  }

  public async setServiceAccountToken(token: string): Promise<void> {
    await this.onePasswordService.setServiceAccountToken(token);
    await this.updateTokenStatusSetting();
  }

  public async clearServiceAccountToken(): Promise<void> {
    await this.onePasswordService.clearServiceAccountToken();
    await this.updateTokenStatusSetting();
  }

  private async updateTokenStatusSetting(): Promise<void> {
    const hasToken = await this.hasServiceAccountToken();
    const config = vscode.workspace.getConfiguration('devOrb.env');
    const statusText = hasToken ? '✅ Token configured securely' : '❌ No token configured';
    await config.update('onePassword.tokenStatus', statusText, vscode.ConfigurationTarget.Global);
  }

  public async getVaults(): Promise<any[]> {
    return this.onePasswordService.getVaults();
  }

  public async ensureDevOrbVault(): Promise<string> {
    return this.onePasswordService.ensureDevOrbVault();
  }

  public getSignupUrl(): string {
    return this.onePasswordService.getSignupUrl();
  }

  // Legacy methods for backward compatibility
  public async getRemoteSecrets(): Promise<RemoteSecret[]> {
    console.warn('⚠️ getRemoteSecrets is deprecated, use getRemoteEnvFiles instead');

    // For backward compatibility, convert file-based data to legacy format
    const remoteFiles = await this.getRemoteEnvFiles();
    const secrets: RemoteSecret[] = [];

    for (const file of remoteFiles) {
      const variables = this.parseEnvContent(file.content);
      for (const variable of variables) {
        secrets.push({
          name: variable.key,
          created_at: file.metadata.lastModified,
          updated_at: file.metadata.lastModified,
          itemId: file.itemId || '',
          filePath: file.metadata.filePath,
          value: variable.value
        });
      }
    }

    return secrets;
  }

  public async getSecretValue(itemId: string): Promise<string | null> {
    console.warn('⚠️ getSecretValue is deprecated with file-based sync');
    // This method is complex to implement with the new approach
    // For now, return null to indicate it's not supported
    return null;
  }

  public async updateSecretValue(itemId: string, newValue: string): Promise<void> {
    console.warn('⚠️ updateSecretValue is deprecated with file-based sync');
    // This would require finding the file, updating the specific variable, and re-syncing
    // For now, just log a warning
  }

  public async deleteSecret(secretName: string): Promise<void> {
    console.warn('⚠️ deleteSecret is deprecated with file-based sync');
    // This would require finding the file, removing the variable, and re-syncing
    // For now, just log a warning
  }

  public dispose(): void {
    this.onePasswordService.dispose();
  }
}