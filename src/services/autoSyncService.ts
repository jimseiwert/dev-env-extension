import * as vscode from 'vscode';
import * as path from 'path';
import { EnvironmentService } from './environment';
import { EnvironmentViewProvider } from '../providers';
import { StatusBarManager } from '../managers/statusBarManager';

export class AutoSyncService {
  private autoSyncTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private envService: EnvironmentService,
    private environmentViewProvider: EnvironmentViewProvider,
    private statusBarManager?: StatusBarManager
  ) {}

  public scheduleAutoSync(filePath: string): void {
    // Clear any existing timeout for this file
    const existingTimeout = this.autoSyncTimeouts.get(filePath);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set a new timeout for this file
    const timeout = setTimeout(async () => {
      await this.performAutoSync(filePath);
      this.autoSyncTimeouts.delete(filePath);
    }, 1000);

    this.autoSyncTimeouts.set(filePath, timeout);
  }

  public async handleFileDeletion(filePath: string): Promise<void> {
    console.log(`🗑️ Handling deletion of env file: ${filePath}`);

    try {
      // With file-based sync, we need to find and delete the corresponding 1Password item
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return;
      }

      const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
      const repoName = this.getRepoName(workspaceFolder.uri.fsPath);

      // Find the remote file
      const remoteFiles = await this.envService.getRemoteEnvFiles();
      const remoteFile = remoteFiles.find(rf => rf.metadata.filePath === relativePath);

      if (remoteFile && remoteFile.itemId) {
        // Delete from 1Password
        const onePasswordService = (this.envService as any).onePasswordService;
        await onePasswordService.deleteEnvFile(remoteFile.itemId);
        console.log(`✅ Deleted remote env file: ${relativePath}`);

        vscode.window.showInformationMessage(
          `🗑️ Deleted ${path.basename(filePath)} from 1Password`
        );
      }
    } catch (error) {
      console.error('Auto-sync file deletion failed:', error);
      vscode.window.showErrorMessage(
        `Failed to delete ${path.basename(filePath)} from 1Password: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async autoCreateMissingEnvFiles(): Promise<void> {
    const envConfig = vscode.workspace.getConfiguration('devOrb.env');
    if (!await this.envService.isConfigured() ||
      !vscode.workspace.workspaceFolders ||
      !envConfig.get('autoCreateFiles', true)) {
      return;
    }

    try {
      console.log('🔄 Auto-creating missing local .env files from 1Password...');

      // Get all remote env files
      const remoteFiles = await this.envService.getRemoteEnvFiles();
      if (remoteFiles.length === 0) {
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders[0];

      for (const remoteFile of remoteFiles) {
        const localPath = path.join(workspaceFolder.uri.fsPath, remoteFile.metadata.filePath);

        try {
          // Check if local file exists
          const fileUri = vscode.Uri.file(localPath);
          await vscode.workspace.fs.stat(fileUri);
          // File exists, skip
        } catch {
          // File doesn't exist - create it
          console.log(`📁 Auto-creating missing local file: ${remoteFile.metadata.filePath}`);
          await this.envService.createLocalFileFromRemote(remoteFile);
        }
      }
    } catch (error) {
      console.error('Auto-create missing env files failed:', error);
    }
  }

  private async performAutoSync(filePath: string): Promise<void> {
    try {
      console.log(`🔄 Starting auto-sync for file: ${filePath}`);

      // Show syncing status in status bar
      await this.statusBarManager?.showSyncingStatus();

      // Check if file still exists (might have been deleted)
      try {
        const fileUri = vscode.Uri.file(filePath);
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        console.log(`📁 File no longer exists, skipping auto-sync: ${filePath}`);
        // Hide syncing status
        await this.statusBarManager?.hideSyncingStatus();
        return;
      }

      // Sync the entire file to 1Password
      await this.envService.syncSingleEnvFile(filePath);

      console.log(`✅ Auto-sync completed for: ${filePath}`);

      const fileName = path.basename(filePath);
      vscode.window.showInformationMessage(
        `📤 Synced ${fileName} to 1Password`,
        { modal: false }
      );

      // Refresh the environment view to show updated status
      await this.environmentViewProvider.refresh();

      // Hide syncing status
      await this.statusBarManager?.hideSyncingStatus();

    } catch (error) {
      console.error('Auto-sync failed:', error);

      const fileName = path.basename(filePath);
      vscode.window.showErrorMessage(
        `Auto-sync failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`
      );

      // Hide syncing status on error
      await this.statusBarManager?.hideSyncingStatus();
    }
  }

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

  public dispose(): void {
    // Clean up any pending timeouts
    for (const timeout of this.autoSyncTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.autoSyncTimeouts.clear();
  }
}