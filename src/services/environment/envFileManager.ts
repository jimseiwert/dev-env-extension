import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createClient, Client, Item, ItemCreateParams, ItemCategory, ItemFieldType } from '@1password/sdk';
import { EnvFile } from '../../types';

export class EnvFileManager {
  private client: Client | null = null;
  private secretStorage: vscode.SecretStorage;
  private vaultId: string = '';

  constructor(secretStorage: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
  }

  public async initialize(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('devOrb');
    this.vaultId = config.get('1Password.vaultId', '');

    const token = await this.secretStorage.get('devOrb.1Password.serviceAccountToken');
    if (!token) return false;

    try {
      this.client = await createClient({
        auth: token,
        integrationName: 'DevOrb VS Code Extension',
        integrationVersion: '1.0.0'
      });
      return true;
    } catch (error) {
      console.error('1Password client initialization failed:', error);
      return false;
    }
  }

  public isReady(): boolean {
    return !!(this.client && this.vaultId);
  }

  // Get repository name from git
  private getRepoName(): string {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      const git = gitExtension?.getAPI(1);
      const repo = git?.repositories?.[0];
      const origin = repo?.state?.remotes?.find((r: any) => r.name === 'origin');
      const match = origin?.fetchUrl?.match(/\/([^\/]+?)(?:\.git)?$/);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }

  // Get relative path from workspace root
  private getRelativePath(filePath: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, filePath) : path.basename(filePath);
  }

  // Create 1Password item for env file
  private async createItem(envFile: EnvFile): Promise<void> {
    if (!this.client) throw new Error('1Password not initialized');

    const repoName = this.getRepoName();
    const relativePath = this.getRelativePath(envFile.filePath);

    const itemData: ItemCreateParams = {
      category: ItemCategory.SecureNote,
      vaultId: this.vaultId,
      title: relativePath,
      tags: ['devorb-env', ...(repoName ? [`repo:${repoName}`] : [])],
      fields: [
        {
          id: 'file-content',
          title: 'File Content',
          fieldType: ItemFieldType.Text,
          value: envFile.content
        },
        {
          id: 'file-path',
          title: 'File Path',
          fieldType: ItemFieldType.Text,
          value: relativePath
        },
        {
          id: 'last-modified',
          title: 'Last Modified',
          fieldType: ItemFieldType.Text,
          value: envFile.lastModified.toISOString()
        },
        ...(repoName ? [{
          id: 'repository',
          title: 'Repository',
          fieldType: ItemFieldType.Text,
          value: repoName
        }] : [])
      ]
    };

    await this.client.items.create(itemData);
  }

  // Update existing 1Password item
  private async updateItem(itemId: string, envFile: EnvFile): Promise<void> {
    if (!this.client) throw new Error('1Password not initialized');

    const item = await this.client.items.get(this.vaultId, itemId);

    // Update fields
    const updatedFields = item.fields.map(field => {
      if (field.title === 'File Content') return { ...field, value: envFile.content };
      if (field.title === 'Last Modified') return { ...field, value: envFile.lastModified.toISOString() };
      return field;
    });

    await this.client.items.put({ ...item, fields: updatedFields });
  }

  // Find 1Password item for env file
  private async findItem(filePath: string): Promise<string | null> {
    if (!this.client) return null;

    const relativePath = this.getRelativePath(filePath);
    const items = await this.client.items.list(this.vaultId);

    const item = items.find(item =>
      item.tags.includes('devorb-env') && item.title === relativePath
    );

    return item ? item.id : null;
  }

  // Get all env files from 1Password
  public async getRemoteEnvFiles(): Promise<EnvFile[]> {
    if (!this.client) return [];

    const items = await this.client.items.list(this.vaultId);
    const envItems = items.filter(item => item.tags.includes('devorb-env'));

    const envFiles: EnvFile[] = [];
    for (const item of envItems) {
      const fullItem = await this.client.items.get(this.vaultId, item.id);
      const contentField = fullItem.fields.find(f => f.title === 'File Content');
      const pathField = fullItem.fields.find(f => f.title === 'File Path');
      const modifiedField = fullItem.fields.find(f => f.title === 'Last Modified');

      if (contentField && pathField) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const fullPath = workspaceFolder
          ? path.join(workspaceFolder.uri.fsPath, pathField.value || '')
          : pathField.value || '';

        envFiles.push({
          filePath: fullPath,
          content: contentField.value || '',
          lastModified: modifiedField?.value ? new Date(modifiedField.value) : new Date(0)
        });
      }
    }

    return envFiles;
  }

  // Get local env file info
  public async getLocalEnvFile(filePath: string): Promise<EnvFile | null> {
    try {
      const stat = await fs.promises.stat(filePath);
      const content = await fs.promises.readFile(filePath, 'utf8');

      return {
        filePath,
        content,
        lastModified: stat.mtime
      };
    } catch {
      return null;
    }
  }

  // Sync local file to 1Password
  public async syncToOnePassword(filePath: string): Promise<void> {
    if (!this.isReady()) throw new Error('1Password not configured');

    const localFile = await this.getLocalEnvFile(filePath);
    if (!localFile) throw new Error('Local file not found');

    const existingItemId = await this.findItem(filePath);

    if (existingItemId) {
      await this.updateItem(existingItemId, localFile);
    } else {
      await this.createItem(localFile);
    }
  }

  // Download from 1Password to local
  public async downloadFromOnePassword(filePath: string): Promise<void> {
    if (!this.isReady()) throw new Error('1Password not configured');

    const existingItemId = await this.findItem(filePath);
    if (!existingItemId) throw new Error('File not found in 1Password');

    const fullItem = await this.client!.items.get(this.vaultId, existingItemId);
    const contentField = fullItem.fields.find(f => f.title === 'File Content');

    if (!contentField?.value) throw new Error('No content found');

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, contentField.value);
  }

  // Delete from 1Password
  public async deleteFromOnePassword(filePath: string): Promise<void> {
    if (!this.isReady()) return;

    const existingItemId = await this.findItem(filePath);
    if (existingItemId) {
      await this.client!.items.delete(this.vaultId, existingItemId);
    }
  }

  // Smart sync - compares timestamps and syncs newer version
  public async smartSync(filePath: string): Promise<'local-to-remote' | 'remote-to-local' | 'no-sync' | 'created'> {
    if (!this.isReady()) throw new Error('1Password not configured');

    const localFile = await this.getLocalEnvFile(filePath);
    const existingItemId = await this.findItem(filePath);

    // Neither exists - nothing to do
    if (!localFile && !existingItemId) return 'no-sync';

    // Only local exists - sync to 1Password
    if (localFile && !existingItemId) {
      await this.createItem(localFile);
      return 'local-to-remote';
    }

    // Only remote exists - download to local
    if (!localFile && existingItemId) {
      await this.downloadFromOnePassword(filePath);
      return 'remote-to-local';
    }

    // Both exist - compare timestamps
    if (localFile && existingItemId) {
      const fullItem = await this.client!.items.get(this.vaultId, existingItemId);
      const modifiedField = fullItem.fields.find(f => f.title === 'Last Modified');
      const remoteModified = modifiedField?.value ? new Date(modifiedField.value) : new Date(0);

      if (localFile.lastModified > remoteModified) {
        await this.updateItem(existingItemId, localFile);
        return 'local-to-remote';
      } else if (remoteModified > localFile.lastModified) {
        await this.downloadFromOnePassword(filePath);
        return 'remote-to-local';
      }
    }

    return 'no-sync';
  }

  // Get all local .env files
  public async getLocalEnvFiles(): Promise<string[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    // Find all local .env files (both .env* and *.env patterns)
    const dotPrefixFiles = await vscode.workspace.findFiles('**/.env*', '**/node_modules/**');
    const dotSuffixFiles = await vscode.workspace.findFiles('**/*.env', '**/node_modules/**');

    // Combine and deduplicate
    const allFiles = [...dotPrefixFiles, ...dotSuffixFiles];
    const envFiles = allFiles.filter((file, index, arr) =>
      arr.findIndex(f => f.fsPath === file.fsPath) === index
    );
    return envFiles.map(file => file.fsPath);
  }

  // Sync all env files (both directions)
  public async syncAll(): Promise<void> {
    if (!this.isReady()) throw new Error('1Password not configured');

    // Get all files from both sources
    const [localFiles, remoteFiles] = await Promise.all([
      this.getLocalEnvFiles(),
      this.getRemoteEnvFiles()
    ]);

    // Create set of all unique file paths
    const allFiles = new Set([
      ...localFiles,
      ...remoteFiles.map(f => f.filePath)
    ]);

    // Smart sync each file
    for (const filePath of allFiles) {
      try {
        await this.smartSync(filePath);
      } catch (error) {
        console.error(`Failed to sync ${filePath}:`, error);
      }
    }
  }

  public dispose(): void {
    this.client = null;
  }
}