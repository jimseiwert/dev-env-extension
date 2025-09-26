import * as vscode from 'vscode';
import * as path from 'path';
import { EnvironmentService } from './environment';
import { FileDecorator } from '../decorators/fileDecorator';
import { StatusBarManager } from '../managers/statusBarManager';
import { GitOperationDetector } from './gitOperationDetector';

export class AutoSyncService {
  private autoSyncTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private dotPrefixWatcher?: vscode.FileSystemWatcher;
  private dotSuffixWatcher?: vscode.FileSystemWatcher;
  private recentlyProcessedFiles: Set<string> = new Set();
  private isAutoSyncRunning: boolean = false;
  private gitOperationDetector: GitOperationDetector;

  constructor(
    private envService: EnvironmentService,
    private fileDecorator: FileDecorator,
    private statusBarManager?: StatusBarManager
  ) {
    this.gitOperationDetector = new GitOperationDetector();
    this.setupFileWatcher();
    this.setupBranchChangeDetection();
    this.setupWorkspaceRefreshDetection();
  }

  private setupFileWatcher(): void {
    // Watch for .env file changes, creations, and deletions (both patterns)
    this.dotPrefixWatcher = vscode.workspace.createFileSystemWatcher('**/.env*');
    this.dotSuffixWatcher = vscode.workspace.createFileSystemWatcher('**/*.env');

    // Set up handlers for both watchers
    this.setupWatcherHandlers(this.dotPrefixWatcher);
    this.setupWatcherHandlers(this.dotSuffixWatcher);
  }

  private setupBranchChangeDetection(): void {
    // Set up branch change callback
    this.gitOperationDetector.onBranchChange(async (workspacePath: string) => {
      console.log(`🔀 Branch change detected in workspace: ${workspacePath}`);
      await this.handleBranchChange();
    });
  }

  private setupWorkspaceRefreshDetection(): void {
    // Listen to workspace folder changes (when user opens/closes folders)
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      console.log('📁 Workspace folders changed, triggering refresh sync...');
      await this.handleWorkspaceRefresh();
    });

    // Listen to file system events that might indicate a refresh
    const refreshWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);

    // Debounce multiple file creation events (typical of git operations or folder refreshes)
    let refreshTimeout: NodeJS.Timeout | undefined;
    refreshWatcher.onDidCreate(async (uri) => {
      // If multiple files are created quickly, it might be a refresh/checkout/etc
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }

      refreshTimeout = setTimeout(async () => {
        try {
          const fileName = path.basename(uri.fsPath);
          if (fileName.includes('.env')) {
            console.log('🔄 Multiple env file changes detected, checking for missing files...');
            await this.autoCreateMissingEnvFiles();
          }
        } catch (error) {
          console.debug('Auto-refresh check failed:', error);
        }
      }, 500); // Short delay to catch multiple rapid file creations
    });
  }

  private setupWatcherHandlers(watcher: vscode.FileSystemWatcher): void {
    // When a new .env file is created, auto-sync it to 1Password
    watcher.onDidCreate(async (uri) => {
      const config = vscode.workspace.getConfiguration('devOrb.env');
      if (!config.get('autoSync', true)) {
        return;
      }

      const isConfigured = await this.envService.isConfigured();
      if (!isConfigured) {
        console.log('⏸️ New file detected but 1Password not configured, skipping auto-sync');
        return;
      }

      if (isConfigured) {
        // Check if we recently processed this file to avoid duplicates
        if (this.isRecentlyProcessed(uri.fsPath)) {
          console.log(`📁 Skipping recently processed file: ${path.basename(uri.fsPath)}`);
          return;
        }

        console.log(`📁 New .env file detected: ${uri.fsPath}`);
        this.markAsRecentlyProcessed(uri.fsPath);

        setTimeout(async () => {
          try {
            await this.envService.syncSingleEnvFile(uri.fsPath);
            console.log(`✅ Auto-synced new file: ${path.basename(uri.fsPath)}`);
            this.fileDecorator.refreshFile(uri);

            vscode.window.showInformationMessage(
              `📤 Auto-synced new file ${path.basename(uri.fsPath)} to 1Password`
            );
          } catch (error) {
            console.error(`Failed to auto-sync new file:`, error);
            vscode.window.showWarningMessage(
              `Failed to auto-sync ${path.basename(uri.fsPath)}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }, 1000); // Small delay to ensure file is fully written
      }
    });

    // When an .env file is modified, schedule auto-sync
    watcher.onDidChange(async (uri) => {
      const config = vscode.workspace.getConfiguration('devOrb.env');
      if (!config.get('autoSync', true)) {
        return;
      }

      const isConfigured = await this.envService.isConfigured();
      if (!isConfigured) {
        console.log('⏸️ File change detected but 1Password not configured, skipping auto-sync');
        return;
      }

      this.scheduleAutoSync(uri.fsPath);
    });

    // When an .env file is deleted, determine if it's user-initiated or git operation
    watcher.onDidDelete(async (uri) => {
      console.log(`📁 .env file deleted: ${uri.fsPath}`);

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this.fileDecorator.refreshFile(uri);
        return;
      }

      try {
        // Detect if this is from a git operation or user deletion
        console.log(`🔍 Detecting operation type for workspace: ${workspaceFolder.uri.fsPath}`);
        const operationType = await this.gitOperationDetector.detectGitOperation(workspaceFolder.uri.fsPath);
        console.log(`🔍 Operation type detected: ${operationType}`);

        if (operationType === 'git') {
          const gitOp = this.gitOperationDetector.getLastGitOperation(workspaceFolder.uri.fsPath);
          console.log(`🔀 File deletion due to git operation (${gitOp}), keeping 1Password copy`);

          // If it's a branch change, schedule a resync after the operation completes
          if (gitOp === 'checkout') {
            setTimeout(async () => {
              try {
                console.log('🔄 Resyncing after branch change...');
                await this.autoCreateMissingEnvFiles();
                vscode.window.showInformationMessage('📁 Resynced env files after branch change');
              } catch (error) {
                console.error('Failed to resync after branch change:', error);
              }
            }, 2000); // Wait 2 seconds for git operation to complete
          }
        } else if (operationType === 'user') {
          console.log(`🗑️ User-initiated deletion detected, handling cleanup`);
          await this.handleUserFileDeletion(uri.fsPath);
        } else {
          console.log(`❓ Unable to determine deletion source (${operationType}), treating as user deletion`);
          // Treat unknown as user deletion to be safe
          await this.handleUserFileDeletion(uri.fsPath);
        }
      } catch (error) {
        console.error('Error handling file deletion:', error);
        // On error, still try to handle as user deletion
        try {
          await this.handleUserFileDeletion(uri.fsPath);
        } catch (fallbackError) {
          console.error('Fallback deletion handling also failed:', fallbackError);
        }
      }

      this.fileDecorator.refreshFile(uri);
    });
  }

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

  private async handleUserFileDeletion(filePath: string): Promise<void> {
    console.log(`🗑️ Handling user-initiated deletion of env file: ${filePath}`);

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
        // Show confirmation dialog
        const choice = await vscode.window.showWarningMessage(
          `Delete ${path.basename(filePath)} from 1Password as well?`,
          'Yes, Delete from 1Password',
          'No, Keep in 1Password'
        );

        if (choice === 'Yes, Delete from 1Password') {
          // Delete from 1Password
          await this.envService.deleteRemoteEnvFile(remoteFile.itemId);
          console.log(`✅ Deleted remote env file: ${relativePath}`);

          vscode.window.showInformationMessage(
            `🗑️ Deleted ${path.basename(filePath)} from 1Password`
          );
        } else {
          console.log(`📁 Keeping ${relativePath} in 1Password as requested`);
          vscode.window.showInformationMessage(
            `📁 Kept ${path.basename(filePath)} in 1Password (can be restored later)`
          );
        }
      }
    } catch (error) {
      console.error('User file deletion handling failed:', error);
      vscode.window.showErrorMessage(
        `Failed to clean up ${path.basename(filePath)} from 1Password: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Legacy method kept for backward compatibility
  public async handleFileDeletion(filePath: string): Promise<void> {
    console.warn('⚠️ handleFileDeletion is deprecated, use handleUserFileDeletion instead');
    await this.handleUserFileDeletion(filePath);
  }

  public async autoCreateMissingEnvFiles(): Promise<void> {
    const envConfig = vscode.workspace.getConfiguration('devOrb.env');

    // Early return if not configured - don't log errors, just skip silently
    if (!await this.envService.isConfigured()) {
      console.log('⏸️ Auto-sync skipped - 1Password not configured');
      return;
    }

    if (!vscode.workspace.workspaceFolders || !envConfig.get('autoCreateFiles', true)) {
      return;
    }

    // Prevent concurrent auto-sync operations
    if (this.isAutoSyncRunning) {
      console.log('⏳ Auto-sync already running, skipping...');
      return;
    }

    this.isAutoSyncRunning = true;

    try {
      console.log('🔄 Auto-sync: Creating missing files and syncing local-only files...');

      // First, create missing local files from remote
      await this.createMissingLocalFiles();

      // Then, sync local-only files to remote
      await this.syncLocalOnlyFiles();

      // Refresh all decorators after auto-sync completes
      this.fileDecorator.refreshAll();

    } catch (error) {
      console.error('Auto-sync failed:', error);
    } finally {
      this.isAutoSyncRunning = false;
    }
  }

  private async createMissingLocalFiles(): Promise<void> {
    console.log('🔄 Auto-creating missing local .env files from 1Password...');

    try {
      // Get all remote env files
      const remoteFiles = await this.envService.getRemoteEnvFiles();
      if (remoteFiles.length === 0) {
        console.log('📁 No remote env files found');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders![0];

      for (const remoteFile of remoteFiles) {
        const localPath = path.join(workspaceFolder.uri.fsPath, remoteFile.metadata.filePath);

        try {
          // Check if local file exists
          const fileUri = vscode.Uri.file(localPath);
          await vscode.workspace.fs.stat(fileUri);
          // File exists, skip
        } catch {
          // File doesn't exist - create it
          try {
            console.log(`📁 Auto-creating missing local file: ${remoteFile.metadata.filePath}`);
            await this.envService.createLocalFileFromRemote(remoteFile);
          } catch (error) {
            console.error(`Failed to create local file ${remoteFile.metadata.filePath}:`, error);
            // Continue with other files
          }
        }
      }
    } catch (error) {
      console.error('Failed to get remote env files:', error);
      // Don't throw - allow the process to continue with local sync
      if (this.isNetworkError(error)) {
        console.log('📡 Network error detected, skipping remote file creation for now');
      }
    }
  }

  private async syncLocalOnlyFiles(): Promise<void> {
    console.log('🔄 Auto-syncing local-only .env files to 1Password...');

    const workspaceFolder = vscode.workspace.workspaceFolders![0];

    // Find all local .env files (both .env* and *.env patterns)
    const dotPrefixFiles = await vscode.workspace.findFiles('**/.env*', '**/node_modules/**');
    const dotSuffixFiles = await vscode.workspace.findFiles('**/*.env', '**/node_modules/**');

    // Combine and deduplicate
    const allFiles = [...dotPrefixFiles, ...dotSuffixFiles];
    const uniqueFiles = allFiles.filter((file, index, arr) =>
      arr.findIndex(f => f.fsPath === file.fsPath) === index
    );
    const localEnvFiles = uniqueFiles;

    if (localEnvFiles.length === 0) {
      console.log('📁 No local .env files found');
      return;
    }

    try {
      // Get remote files to check what already exists
      const remoteFiles = await this.envService.getRemoteEnvFiles();

      for (const localFile of localEnvFiles) {
        const relativePath = path.relative(workspaceFolder.uri.fsPath, localFile.fsPath);
        const fileName = path.basename(localFile.fsPath);

        // Check if this file exists remotely
        const remoteFile = remoteFiles.find(rf =>
          rf.metadata.filePath === relativePath || path.basename(rf.metadata.filePath) === fileName
        );

        if (!remoteFile) {
          // File exists locally but not remotely - sync it up
          console.log(`📤 Auto-syncing local-only file: ${relativePath}`);
          try {
            // Mark as recently processed to avoid duplicate file watcher triggers
            this.markAsRecentlyProcessed(localFile.fsPath);

            await this.envService.syncSingleEnvFile(localFile.fsPath);
            console.log(`✅ Auto-synced ${fileName} to 1Password`);

            // Refresh the file decorator for this specific file
            this.fileDecorator.refreshFile(localFile);
          } catch (error) {
            console.error(`Failed to auto-sync ${fileName}:`, error);
            // Continue with other files
          }
        }
      }
    } catch (error) {
      console.error('Failed to get remote files for sync comparison:', error);
      if (this.isNetworkError(error)) {
        console.log('📡 Network error detected, will retry auto-sync later');
      }
    }
  }

  private isNetworkError(error: any): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const errorString = error.message || error.toString() || '';
    const lowerError = errorString.toLowerCase();

    return (
      lowerError.includes('504') ||
      lowerError.includes('gateway timeout') ||
      lowerError.includes('timeout') ||
      lowerError.includes('502') ||
      lowerError.includes('bad gateway') ||
      lowerError.includes('503') ||
      lowerError.includes('service unavailable') ||
      lowerError.includes('connection') ||
      lowerError.includes('network') ||
      lowerError.includes('fetch')
    );
  }

  private markAsRecentlyProcessed(filePath: string): void {
    this.recentlyProcessedFiles.add(filePath);

    // Clear the flag after 5 seconds to allow future processing
    setTimeout(() => {
      this.recentlyProcessedFiles.delete(filePath);
    }, 5000);
  }

  private isRecentlyProcessed(filePath: string): boolean {
    return this.recentlyProcessedFiles.has(filePath);
  }

  private async performAutoSync(filePath: string): Promise<void> {
    try {
      // Check if 1Password is configured before attempting sync
      const isConfigured = await this.envService.isConfigured();
      if (!isConfigured) {
        console.log(`⏸️ Auto-sync skipped for ${filePath} - 1Password not configured`);
        return;
      }

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

      // Refresh the file decorator to show updated sync status
      this.fileDecorator.refreshFile(vscode.Uri.file(filePath));

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

  public async handleBranchChange(): Promise<void> {
    console.log('🔀 Branch change detected, resyncing env files...');

    try {
      // Wait a moment for git operations to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Perform a full resync to handle any differences between branches
      await this.autoCreateMissingEnvFiles();

      vscode.window.showInformationMessage(
        '🔄 Resynced env files after branch change'
      );

    } catch (error) {
      console.error('Failed to resync after branch change:', error);
      vscode.window.showWarningMessage(
        `Failed to resync env files after branch change: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleWorkspaceRefresh(): Promise<void> {
    console.log('📁 Workspace refresh detected, checking for missing env files...');

    try {
      // Small delay to let workspace settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check if 1Password is configured before attempting sync
      const isConfigured = await this.envService.isConfigured();
      if (!isConfigured) {
        console.log('⏸️ 1Password not configured, skipping workspace refresh sync');
        // Still refresh decorations
        this.fileDecorator.refreshAll();
        return;
      }

      // Perform auto-sync to create missing files and sync local ones
      await this.autoCreateMissingEnvFiles();

      // Refresh decorations to show updated sync status
      this.fileDecorator.refreshAll();

    } catch (error) {
      console.error('Failed to handle workspace refresh:', error);
      // Still try to refresh decorations on error
      this.fileDecorator.refreshAll();
    }
  }

  public dispose(): void {
    // Clean up any pending timeouts
    for (const timeout of this.autoSyncTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.autoSyncTimeouts.clear();

    // Dispose of file watchers
    this.dotPrefixWatcher?.dispose();
    this.dotSuffixWatcher?.dispose();

    // Dispose of git operation detector
    this.gitOperationDetector.dispose();
  }
}