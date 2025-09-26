import * as vscode from 'vscode';
import * as path from 'path';
import { EnvironmentService } from '../services';

export enum FileSyncStatus {
  LOCAL_ONLY = 'local_only',
  SYNCED = 'synced',
  REMOTE_NEWER = 'remote_newer',
  LOCAL_NEWER = 'local_newer'
}

export class FileDecorator implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

  private syncStatusCache = new Map<string, FileSyncStatus>();

  constructor(private envService: EnvironmentService) {}

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (!this.isEnvFile(uri)) {
      return undefined;
    }

    const status = await this.getFileSyncStatus(uri);
    return this.getDecorationForStatus(status);
  }

  private isEnvFile(uri: vscode.Uri): boolean {
    const fileName = path.basename(uri.fsPath);
    return fileName === '.env' || fileName.startsWith('.env.') || fileName.endsWith('.env');
  }

  private async getFileSyncStatus(uri: vscode.Uri): Promise<FileSyncStatus> {
    const cacheKey = uri.fsPath;

    // Check cache first
    if (this.syncStatusCache.has(cacheKey)) {
      return this.syncStatusCache.get(cacheKey)!;
    }

    try {
      const isConfigured = await this.envService.isConfigured();
      if (!isConfigured) {
        this.syncStatusCache.set(cacheKey, FileSyncStatus.LOCAL_ONLY);
        return FileSyncStatus.LOCAL_ONLY;
      }

      // Get remote files to check sync status
      const remoteFiles = await this.envService.getRemoteEnvFiles();
      const fileName = path.basename(uri.fsPath);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

      if (!workspaceFolder) {
        this.syncStatusCache.set(cacheKey, FileSyncStatus.LOCAL_ONLY);
        return FileSyncStatus.LOCAL_ONLY;
      }

      const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
      const remoteFile = remoteFiles.find(rf =>
        rf.metadata.filePath === relativePath || path.basename(rf.metadata.filePath) === fileName
      );

      if (!remoteFile) {
        this.syncStatusCache.set(cacheKey, FileSyncStatus.LOCAL_ONLY);
        return FileSyncStatus.LOCAL_ONLY;
      }

      // Check if local file exists and compare timestamps
      try {
        const localStat = await vscode.workspace.fs.stat(uri);
        const localModified = localStat.mtime;
        const remoteModified = new Date(remoteFile.metadata.lastModified).getTime();

        let status: FileSyncStatus;
        if (Math.abs(localModified - remoteModified) < 5000) { // 5 second tolerance
          status = FileSyncStatus.SYNCED;
        } else if (localModified > remoteModified) {
          status = FileSyncStatus.LOCAL_NEWER;
        } else {
          status = FileSyncStatus.REMOTE_NEWER;
        }

        this.syncStatusCache.set(cacheKey, status);
        return status;
      } catch {
        // Local file doesn't exist
        this.syncStatusCache.set(cacheKey, FileSyncStatus.LOCAL_ONLY);
        return FileSyncStatus.LOCAL_ONLY;
      }
    } catch (error) {
      console.error('Error determining file sync status:', error);
      this.syncStatusCache.set(cacheKey, FileSyncStatus.LOCAL_ONLY);
      return FileSyncStatus.LOCAL_ONLY;
    }
  }

  private getDecorationForStatus(status: FileSyncStatus): vscode.FileDecoration {
    switch (status) {
      case FileSyncStatus.LOCAL_ONLY:
        return {
          badge: '↑',
          tooltip: 'Local only - not synced to 1Password',
          color: new vscode.ThemeColor('charts.orange')
        };
      case FileSyncStatus.SYNCED:
        return {
          badge: '✓',
          tooltip: 'Synced with 1Password',
          color: new vscode.ThemeColor('charts.green')
        };
      case FileSyncStatus.LOCAL_NEWER:
        return {
          badge: '↑',
          tooltip: 'Local changes need to be uploaded to 1Password',
          color: new vscode.ThemeColor('charts.blue')
        };
      case FileSyncStatus.REMOTE_NEWER:
        return {
          badge: '↓',
          tooltip: 'Remote changes available from 1Password',
          color: new vscode.ThemeColor('charts.purple')
        };
    }
  }

  public refreshFile(uri: vscode.Uri): void {
    this.syncStatusCache.delete(uri.fsPath);
    this._onDidChangeFileDecorations.fire(uri);
  }

  public refreshAll(): void {
    this.syncStatusCache.clear();
    this._onDidChangeFileDecorations.fire(vscode.Uri.file(''));
  }

  public dispose(): void {
    this._onDidChangeFileDecorations.dispose();
    this.syncStatusCache.clear();
  }
}