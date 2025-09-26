import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { OnePasswordService } from './onePasswordService';
import { EnvFileMetadata, SyncedEnvFile } from '../../types/environment';

export class EnvFileSyncService {
  constructor(private onePasswordService: OnePasswordService) {}

  /**
   * Sync all .env files in the workspace with 1Password
   * Creates missing files locally from 1Password and uploads missing files to 1Password
   */
  public async syncAllFiles(): Promise<void> {
    if (!await this.onePasswordService.isConfigured()) {
      throw new Error('1Password not configured');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder found');
    }

    const repoName = this.getRepoName(workspaceFolder.uri.fsPath);

    console.log(`🔄 Starting full sync for repository: ${repoName}`);

    // Get all local .env files
    const localFiles = await this.scanLocalEnvFiles();
    console.log(`📁 Found ${localFiles.length} local .env files`);

    // Get all remote .env files for this repo
    const remoteFiles = await this.getRemoteEnvFiles(repoName);
    console.log(`☁️ Found ${remoteFiles.length} remote .env files in 1Password`);

    // Create files locally that exist in 1Password but not locally
    await this.createMissingLocalFiles(localFiles, remoteFiles);

    // Upload files to 1Password that exist locally but not remotely
    await this.uploadMissingRemoteFiles(localFiles, remoteFiles, repoName);

    // Update files that exist in both but have differences
    await this.syncModifiedFiles(localFiles, remoteFiles, repoName);

    console.log('✅ Full sync completed');
  }

  /**
   * Sync a single .env file to 1Password
   */
  public async syncFileToRemote(filePath: string): Promise<void> {
    if (!await this.onePasswordService.isConfigured()) {
      throw new Error('1Password not configured');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder found');
    }

    const repoName = this.getRepoName(workspaceFolder.uri.fsPath);
    const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);

    console.log(`📤 Syncing file to 1Password: ${relativePath}`);

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const stats = fs.statSync(filePath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      const metadata: EnvFileMetadata = {
        repoName,
        filePath: relativePath,
        lastModified: stats.mtime.toISOString(),
        hash,
        source: 'local'
      };

      // Check if file already exists in 1Password
      const existingItem = await this.onePasswordService.findEnvFileByPath(repoName, relativePath);

      if (existingItem) {
        // Update existing file
        await this.onePasswordService.updateEnvFile(existingItem.id, content, metadata);
        console.log(`✅ Updated existing file in 1Password: ${relativePath}`);
      } else {
        // Create new file
        await this.onePasswordService.createEnvFile(relativePath, content, metadata);
        console.log(`✅ Created new file in 1Password: ${relativePath}`);
      }
    } catch (error) {
      console.error(`❌ Failed to sync file ${relativePath}:`, error);
      throw error;
    }
  }

  /**
   * Create a local .env file from 1Password
   */
  public async createFileFromRemote(remoteFile: SyncedEnvFile): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder found');
    }

    const fullPath = path.join(workspaceFolder.uri.fsPath, remoteFile.metadata.filePath);

    console.log(`📥 Creating local file from 1Password: ${remoteFile.metadata.filePath}`);

    try {
      // Create directory if it doesn't exist
      const dirPath = path.dirname(fullPath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Write file content
      fs.writeFileSync(fullPath, remoteFile.content, 'utf8');

      // Set file modification time to match remote
      const modTime = new Date(remoteFile.metadata.lastModified);
      fs.utimesSync(fullPath, modTime, modTime);

      console.log(`✅ Created local file: ${remoteFile.metadata.filePath}`);

      vscode.window.showInformationMessage(
        `📁 Created ${path.basename(fullPath)} from 1Password`
      );
    } catch (error) {
      console.error(`❌ Failed to create local file ${remoteFile.metadata.filePath}:`, error);
      throw error;
    }
  }

  private async scanLocalEnvFiles(): Promise<SyncedEnvFile[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const envFiles = await vscode.workspace.findFiles('**/.env*', '**/node_modules/**');
    const syncedFiles: SyncedEnvFile[] = [];

    for (const fileUri of envFiles) {
      try {
        const content = fs.readFileSync(fileUri.fsPath, 'utf8');
        const stats = fs.statSync(fileUri.fsPath);
        const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');

        syncedFiles.push({
          content,
          metadata: {
            repoName: this.getRepoName(workspaceFolder.uri.fsPath),
            filePath: relativePath,
            lastModified: stats.mtime.toISOString(),
            hash,
            source: 'local'
          }
        });
      } catch (error) {
        console.warn(`Could not read env file ${fileUri.fsPath}:`, error);
      }
    }

    return syncedFiles;
  }

  private async getRemoteEnvFiles(repoName: string): Promise<SyncedEnvFile[]> {
    return await this.onePasswordService.getEnvFilesForRepo(repoName);
  }

  private async createMissingLocalFiles(
    localFiles: SyncedEnvFile[],
    remoteFiles: SyncedEnvFile[]
  ): Promise<void> {
    const localPaths = new Set(localFiles.map(f => f.metadata.filePath));

    for (const remoteFile of remoteFiles) {
      if (!localPaths.has(remoteFile.metadata.filePath)) {
        console.log(`📥 Creating missing local file: ${remoteFile.metadata.filePath}`);
        await this.createFileFromRemote(remoteFile);
      }
    }
  }

  private async uploadMissingRemoteFiles(
    localFiles: SyncedEnvFile[],
    remoteFiles: SyncedEnvFile[],
    repoName: string
  ): Promise<void> {
    const remotePaths = new Set(remoteFiles.map(f => f.metadata.filePath));

    for (const localFile of localFiles) {
      if (!remotePaths.has(localFile.metadata.filePath)) {
        console.log(`📤 Uploading missing remote file: ${localFile.metadata.filePath}`);

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          const fullPath = path.join(workspaceFolder.uri.fsPath, localFile.metadata.filePath);
          await this.syncFileToRemote(fullPath);
        }
      }
    }
  }

  private async syncModifiedFiles(
    localFiles: SyncedEnvFile[],
    remoteFiles: SyncedEnvFile[],
    repoName: string
  ): Promise<void> {
    const remoteFileMap = new Map(remoteFiles.map(f => [f.metadata.filePath, f]));

    for (const localFile of localFiles) {
      const remoteFile = remoteFileMap.get(localFile.metadata.filePath);

      if (remoteFile && localFile.metadata.hash !== remoteFile.metadata.hash) {
        console.log(`🔄 Files differ for ${localFile.metadata.filePath}`);

        // Compare modification times to determine which is newer
        const localTime = new Date(localFile.metadata.lastModified);
        const remoteTime = new Date(remoteFile.metadata.lastModified);

        if (localTime > remoteTime) {
          console.log(`📤 Local file is newer, uploading: ${localFile.metadata.filePath}`);
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            const fullPath = path.join(workspaceFolder.uri.fsPath, localFile.metadata.filePath);
            await this.syncFileToRemote(fullPath);
          }
        } else if (remoteTime > localTime) {
          console.log(`📥 Remote file is newer, downloading: ${remoteFile.metadata.filePath}`);
          await this.createFileFromRemote(remoteFile);
        } else {
          console.log(`⚠️ Files have different content but same timestamp: ${localFile.metadata.filePath}`);
          // Could show a conflict resolution dialog here
          await this.showConflictDialog(localFile, remoteFile);
        }
      }
    }
  }

  private async showConflictDialog(localFile: SyncedEnvFile, remoteFile: SyncedEnvFile): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Conflict detected for ${localFile.metadata.filePath}. Files have different content but same modification time.`,
      'Use Local Version',
      'Use Remote Version',
      'Show Diff'
    );

    if (choice === 'Use Local Version') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const fullPath = path.join(workspaceFolder.uri.fsPath, localFile.metadata.filePath);
        await this.syncFileToRemote(fullPath);
      }
    } else if (choice === 'Use Remote Version') {
      await this.createFileFromRemote(remoteFile);
    } else if (choice === 'Show Diff') {
      // Could implement diff view here
      vscode.window.showInformationMessage('Diff view not implemented yet. Please resolve manually.');
    }
  }

  private getRepoName(workspacePath: string): string {
    // Try to get repo name from git if available
    try {
      const gitConfigPath = path.join(workspacePath, '.git', 'config');
      if (fs.existsSync(gitConfigPath)) {
        const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
        const match = gitConfig.match(/url = .*[\/:]([^\/]+)\.git/);
        if (match) {
          return match[1];
        }
      }
    } catch (error) {
      console.warn('Could not read git config:', error);
    }

    // Fallback to workspace folder name
    return path.basename(workspacePath);
  }
}