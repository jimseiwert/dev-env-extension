import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import fetch from 'node-fetch';
import { SyncConfig, SyncableFile, GistData, SyncStatus, SyncConflict } from './types';

export class ClaudeSyncService {
  private config: SyncConfig;
  private status: SyncStatus;
  private claudeDir: string;
  private syncTimer?: NodeJS.Timeout;
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private githubSession: vscode.AuthenticationSession | null = null;

  constructor() {
    this.claudeDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
    this.config = this.loadConfig();
    this.status = {
      lastSync: 0,
      issyncing: false,
      conflicts: [],
      errors: []
    };
  }

  private loadConfig(): SyncConfig {
    const config = vscode.workspace.getConfiguration('claudeSync');
    return {
      enabled: config.get('enabled', false),
      gistId: config.get('gistId'),
      syncItems: {
        settings: config.get('syncItems.settings', true),
        subagents: config.get('syncItems.subagents', true),
        hooks: config.get('syncItems.hooks', true),
        slashCommands: config.get('syncItems.slashCommands', true),
        plugins: config.get('syncItems.plugins', true),
        claudeMd: config.get('syncItems.claudeMd', false)
      },
      excludePatterns: config.get('excludePatterns', [
        'statsig/**',
        '**/*.lock',
        'shell-snapshots/**',
        '**/*.jsonl',
        'ide/**',
        'todos/**'
      ]),
      autoSync: config.get('autoSync', true),
      syncInterval: config.get('syncInterval', 30)
    };
  }

  public async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Authenticate with GitHub
    await this.authenticateGitHub();

    // Initial sync on startup if authenticated
    if (this.githubSession) {
      await this.performSync();
    }

    // Set up file watchers
    this.setupFileWatchers();

    // Set up periodic sync
    if (this.config.autoSync) {
      this.setupPeriodicSync();
    }
  }

  private setupFileWatchers(): void {
    const syncablePaths = this.getSyncablePaths();

    for (const syncPath of syncablePaths) {
      const pattern = new vscode.RelativePattern(this.claudeDir, syncPath);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidChange(() => this.onFileChange());
      watcher.onDidCreate(() => this.onFileChange());
      watcher.onDidDelete(() => this.onFileChange());

      this.fileWatchers.push(watcher);
    }
  }

  private getSyncablePaths(): string[] {
    const paths: string[] = [];

    if (this.config.syncItems.settings) {
      paths.push('settings.json');
    }
    if (this.config.syncItems.subagents) {
      paths.push('subagents.json');
    }
    if (this.config.syncItems.hooks) {
      paths.push('hooks.json');
    }
    if (this.config.syncItems.slashCommands) {
      paths.push('slash-commands/**');
    }
    if (this.config.syncItems.plugins) {
      paths.push('plugins/**');
    }
    if (this.config.syncItems.claudeMd) {
      paths.push('**/CLAUDE.md');
    }

    return paths;
  }

  private setupPeriodicSync(): void {
    this.syncTimer = setInterval(async () => {
      await this.performSync();
    }, this.config.syncInterval * 60 * 1000);
  }

  private async authenticateGitHub(): Promise<void> {
    try {
      // First try to get existing session without creating a new one
      const existingSessions = await vscode.authentication.getSession('github', ['gist'], { createIfNone: false });

      if (existingSessions) {
        this.githubSession = existingSessions;
        return;
      }

      // If no existing session, prompt user to sign in
      this.githubSession = await vscode.authentication.getSession('github', ['gist'], {
        createIfNone: true,
        forceNewSession: false
      });

    } catch (error) {
      this.status.errors.push(`GitHub authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error('GitHub authentication error:', error);
    }
  }

  public async ensureAuthenticated(): Promise<boolean> {
    if (!this.githubSession) {
      await this.authenticateGitHub();
    }
    return this.githubSession !== null;
  }

  private async onFileChange(): Promise<void> {
    // Debounce file changes
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(async () => {
      await this.performSync();
    }, 5000); // Wait 5 seconds after last change
  }

  public async performSync(): Promise<void> {
    if (this.status.issyncing) {
      return;
    }

    // Ensure we're authenticated
    if (!(await this.ensureAuthenticated())) {
      this.status.errors.push('GitHub authentication required for sync');
      return;
    }

    this.status.issyncing = true;
    this.status.errors = [];

    try {
      const localFiles = await this.scanLocalFiles();
      const gistData = await this.fetchGist();

      const conflicts = this.detectConflicts(localFiles, gistData);

      if (conflicts.length > 0) {
        this.status.conflicts = conflicts;
        await this.showConflictResolution(conflicts);
        return;
      }

      await this.uploadToGist(localFiles);
      await this.downloadFromGist(gistData, localFiles);

      this.status.lastSync = Date.now();

    } catch (error) {
      this.status.errors.push(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      vscode.window.showErrorMessage(`Claude Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.status.issyncing = false;
    }
  }

  private async scanLocalFiles(): Promise<SyncableFile[]> {
    const files: SyncableFile[] = [];

    // Check if Claude directory exists
    if (!fs.existsSync(this.claudeDir)) {
      console.log('Claude directory does not exist:', this.claudeDir);
      return files;
    }

    for (const syncPath of this.getSyncablePaths()) {
      try {
        const fullPath = path.join(this.claudeDir, syncPath);

        // Handle wildcard patterns differently
        if (syncPath.includes('*')) {
          // For now, skip wildcard patterns as they need glob resolution
          continue;
        }

        if (fs.existsSync(fullPath)) {
          const stats = fs.statSync(fullPath);

          if (stats.isFile()) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const hash = crypto.createHash('sha256').update(content).digest('hex');
              const relativePath = path.relative(this.claudeDir, fullPath);

              files.push({
                path: fullPath,
                relativePath,
                content,
                lastModified: stats.mtime.getTime(),
                hash
              });

              console.log('Found file to sync:', relativePath);
            } catch (readError) {
              console.warn('Could not read file:', fullPath, readError);
            }
          }
        } else {
          console.log('File does not exist:', fullPath);
        }
      } catch (error) {
        console.warn('Error processing path:', syncPath, error);
      }
    }

    // If no files found, create a test sync file to ensure gist creation works
    if (files.length === 0) {
      const testContent = JSON.stringify({
        syncEnabled: true,
        lastCheck: new Date().toISOString(),
        version: "1.0.0"
      }, null, 2);

      files.push({
        path: path.join(this.claudeDir, 'sync-test.json'),
        relativePath: 'sync-test.json',
        content: testContent,
        lastModified: Date.now(),
        hash: crypto.createHash('sha256').update(testContent).digest('hex')
      });

      console.log('No Claude config files found, created test sync file');
    }

    console.log(`Found ${files.length} files to sync`);
    return files;
  }

  private async fetchGist(): Promise<GistData | null> {
    if (!this.config.gistId || !this.githubSession) {
      return null;
    }

    const response = await fetch(`https://api.github.com/gists/${this.config.gistId}`, {
      headers: {
        'Authorization': `Bearer ${this.githubSession.accessToken}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch gist: ${response.statusText}`);
    }

    return await response.json();
  }

  private detectConflicts(localFiles: SyncableFile[], gistData: GistData | null): SyncConflict[] {
    // Implementation for conflict detection
    return [];
  }

  private async showConflictResolution(conflicts: SyncConflict[]): Promise<void> {
    // Implementation for conflict resolution UI
  }

  private async uploadToGist(files: SyncableFile[]): Promise<void> {
    if (!this.githubSession) {
      throw new Error('GitHub authentication required');
    }

    // Skip if no files to sync
    if (files.length === 0) {
      console.log('No files to sync');
      return;
    }

    const gistFiles: { [filename: string]: { content: string } } = {};

    for (const file of files) {
      // Ensure filename is valid (no path separators that might cause issues)
      const safeFilename = file.relativePath.replace(/\\/g, '/');
      // Ensure content is not empty and is a string
      const content = file.content || '';

      if (safeFilename && typeof content === 'string') {
        gistFiles[safeFilename] = { content };
      }
    }

    // Ensure we have at least one file
    if (Object.keys(gistFiles).length === 0) {
      console.log('No valid files to sync');
      return;
    }

    const gistData = {
      description: 'Claude Code Configuration Sync',
      public: false,
      files: gistFiles
    };

    const url = this.config.gistId
      ? `https://api.github.com/gists/${this.config.gistId}`
      : 'https://api.github.com/gists';

    const method = this.config.gistId ? 'PATCH' : 'POST';

    console.log(`Uploading to gist via ${method} to ${url}`, {
      fileCount: Object.keys(gistFiles).length,
      files: Object.keys(gistFiles)
    });

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.githubSession.accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'VS Code Extension Claude Sync'
      },
      body: JSON.stringify(gistData)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Gist API error:', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody
      });
      throw new Error(`Failed to update gist: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const result = await response.json();

    if (!this.config.gistId) {
      // Save the new gist ID
      await vscode.workspace.getConfiguration('claudeSync').update('gistId', result.id, vscode.ConfigurationTarget.Global);
      this.config.gistId = result.id;
      console.log('Created new gist with ID:', result.id);
    }
  }

  private async downloadFromGist(gistData: GistData | null, localFiles: SyncableFile[]): Promise<void> {
    if (!gistData) {
      return;
    }

    for (const [filename, fileData] of Object.entries(gistData.files)) {
      const localFile = localFiles.find(f => f.relativePath === filename);
      const fullPath = path.join(this.claudeDir, filename);

      // Only download if file doesn't exist locally or remote is newer
      if (!localFile || this.shouldUpdateFromRemote(localFile, fileData)) {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(fullPath, fileData.content, 'utf8');
      }
    }
  }

  private shouldUpdateFromRemote(localFile: SyncableFile, remoteFile: { content: string }): boolean {
    const remoteHash = crypto.createHash('sha256').update(remoteFile.content).digest('hex');
    return localFile.hash !== remoteHash;
  }

  public getSyncStatus(): SyncStatus {
    return { ...this.status };
  }

  public dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    for (const watcher of this.fileWatchers) {
      watcher.dispose();
    }
    this.fileWatchers = [];
  }
}