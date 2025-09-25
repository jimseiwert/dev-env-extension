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
    this.claudeDir = this.findClaudeDirectory();
    this.config = this.loadConfig();
    this.status = {
      lastSync: 0,
      issyncing: false,
      conflicts: [],
      errors: []
    };
  }

  private findClaudeDirectory(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      // Fallback to user home directory
      return path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;

    // First try root of workspace
    const rootClaudeDir = path.join(workspaceRoot, '.claude');
    if (fs.existsSync(rootClaudeDir)) {
      console.log('Found .claude directory at workspace root:', rootClaudeDir);
      return rootClaudeDir;
    }

    // Search all level 1 directories in workspace for .claude folder
    try {
      const items = fs.readdirSync(workspaceRoot);

      for (const item of items) {
        const itemPath = path.join(workspaceRoot, item);

        try {
          const stats = fs.statSync(itemPath);
          if (stats.isDirectory() && !item.startsWith('.')) {
            const claudeDir = path.join(itemPath, '.claude');
            if (fs.existsSync(claudeDir)) {
              const claudeStats = fs.statSync(claudeDir);
              if (claudeStats.isDirectory()) {
                console.log(`Found .claude directory at: ${claudeDir}`);
                return claudeDir;
              }
            }
          }
        } catch (error) {
          // Ignore permission errors, etc.
        }
      }
    } catch (error) {
      console.warn('Could not read workspace root directory:', workspaceRoot);
    }

    console.log('No .claude directory found in workspace, using home directory fallback');
    return path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
  }

  private loadConfig(): SyncConfig {
    const mainConfig = vscode.workspace.getConfiguration('devMind');
    const config = vscode.workspace.getConfiguration('devMind.claude');
    return {
      enabled: mainConfig.get('enabled', true) && config.get('enabled', true),
      gists: {
        settings: config.get('gists.settings'),
        agents: config.get('gists.agents'),
        commands: config.get('gists.commands'),
        plugins: config.get('gists.plugins'),
        projects: config.get('gists.projects')
      },
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
    // Create type-specific watchers for better granularity
    const fileTypeWatchers = [
      {
        type: 'settings',
        paths: ['settings.json'],
        enabled: this.config.syncItems.settings
      },
      {
        type: 'agents',
        paths: ['subagents.json', 'hooks.json'],
        enabled: this.config.syncItems.subagents || this.config.syncItems.hooks
      },
      {
        type: 'commands',
        paths: ['slash-commands/**'],
        enabled: this.config.syncItems.slashCommands
      },
      {
        type: 'plugins',
        paths: ['plugins/**'],
        enabled: this.config.syncItems.plugins
      },
      {
        type: 'projects',
        paths: ['**/CLAUDE.md'],
        enabled: this.config.syncItems.claudeMd
      }
    ];

    for (const watcherConfig of fileTypeWatchers) {
      if (!watcherConfig.enabled) continue;

      for (const syncPath of watcherConfig.paths) {
        const pattern = new vscode.RelativePattern(this.claudeDir, syncPath);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        // Create type-specific callback
        const callback = () => this.onFileChange(watcherConfig.type);

        watcher.onDidChange(callback);
        watcher.onDidCreate(callback);
        watcher.onDidDelete(callback);

        this.fileWatchers.push(watcher);
      }
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
      console.log('🔐 DevMind Claude Sync: Attempting GitHub authentication...');

      // First try to get existing session without creating a new one
      const existingSessions = await vscode.authentication.getSession('github', ['gist'], { createIfNone: false });

      if (existingSessions) {
        console.log('✅ DevMind Claude Sync: Found existing GitHub session');
        this.githubSession = existingSessions;
        return;
      }

      console.log('🔐 DevMind Claude Sync: No existing session found, requesting new authentication...');
      // If no existing session, prompt user to sign in
      this.githubSession = await vscode.authentication.getSession('github', ['gist'], {
        createIfNone: true,
        forceNewSession: false
      });

      if (this.githubSession) {
        console.log('✅ DevMind Claude Sync: GitHub authentication successful');
      } else {
        console.log('❌ DevMind Claude Sync: GitHub authentication returned null session');
      }

    } catch (error) {
      const errorMessage = `GitHub authentication failed: ${error instanceof Error ? error.message : String(error)}`;
      this.status.errors.push(errorMessage);
      console.error('❌ DevMind Claude Sync:', errorMessage, error);
    }
  }

  public async ensureAuthenticated(): Promise<boolean> {
    if (!this.githubSession) {
      await this.authenticateGitHub();
    }
    return this.githubSession !== null;
  }

  private async createGistForType(gistType: string, files: { [filename: string]: { content: string } }): Promise<string | null> {
    if (!this.githubSession) {
      return null;
    }

    const descriptions: { [key: string]: string } = {
      settings: 'Claude Code Settings',
      agents: 'Claude Code Agents',
      commands: 'Claude Code Slash Commands',
      plugins: 'Claude Code Plugins',
      projects: 'Claude Code Project Files'
    };

    // Validate that we have files to upload
    if (!files || Object.keys(files).length === 0) {
      console.warn(`❌ DevMind Claude Sync: No files provided for ${gistType} gist creation`);
      return null;
    }

    // Validate that files have content and unique names
    const seenFilenames = new Set<string>();
    for (const [filename, fileData] of Object.entries(files)) {
      if (!fileData.content || typeof fileData.content !== 'string') {
        console.warn(`❌ DevMind Claude Sync: Invalid file content for ${filename} in ${gistType} gist`);
        return null;
      }

      if (fileData.content.trim().length === 0) {
        console.warn(`❌ DevMind Claude Sync: Empty file content for ${filename} in ${gistType} gist`);
        return null;
      }

      if (seenFilenames.has(filename)) {
        console.warn(`❌ DevMind Claude Sync: Duplicate filename ${filename} in ${gistType} gist`);
        return null;
      }
      seenFilenames.add(filename);
    }

    try {
      const gistData = {
        description: descriptions[gistType] || `DevMind Claude ${gistType}`,
        public: false,
        files
      };

      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.githubSession.accessToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'VS Code Extension DevMind'
        },
        body: JSON.stringify(gistData)
      });

      if (response.ok) {
        const result = await response.json();
        // Update configuration with new gist ID
        await this.updateGistIdInConfig(gistType, result.id);

        console.log(`Created new ${gistType} gist with ID:`, result.id);
        return result.id;
      } else {
        const errorBody = await response.text();
        console.error(`❌ DevMind Claude Sync: Failed to create gist for group '${gistType}': ${response.status} ${response.statusText} - ${errorBody}`);
        this.status.errors.push(`Failed to create ${gistType} gist: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error(`❌ DevMind Claude Sync: Failed to create gist for group '${gistType}':`, error);
      this.status.errors.push(`Failed to create ${gistType} gist: ${error instanceof Error ? error.message : String(error)}`);
    }

    return null;
  }

  private async updateGistIdInConfig(gistType: string, gistId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('devMind.claude');
    await config.update(`gists.${gistType}`, gistId, vscode.ConfigurationTarget.Global);

    // Update local config object for known types
    const gistConfig = this.config.gists as any;
    gistConfig[gistType] = gistId;

    console.log(`Updated config: gists.${gistType} = ${gistId}`);
  }

  private async onFileChange(fileType?: string): Promise<void> {
    // Debounce file changes
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(async () => {
      if (fileType) {
        // Type-specific sync
        await this.performPartialSync(fileType);
      } else {
        // Full sync (fallback)
        await this.performSync();
      }
    }, 5000); // Wait 5 seconds after last change
  }

  public async performSync(): Promise<void> {
    console.log('🔄 DevMind Claude Sync: Starting sync process...');

    if (this.status.issyncing) {
      console.log('⏸️ DevMind Claude Sync: Already syncing, skipping...');
      return;
    }

    console.log('🔍 DevMind Claude Sync: Claude directory:', this.claudeDir);

    // Ensure we're authenticated
    console.log('🔐 DevMind Claude Sync: Checking authentication...');
    if (!(await this.ensureAuthenticated())) {
      console.log('❌ DevMind Claude Sync: Authentication failed');
      this.status.errors.push('GitHub authentication required for sync');
      return;
    }
    console.log('✅ DevMind Claude Sync: Authentication successful');

    this.status.issyncing = true;
    this.status.errors = [];

    try {
      console.log('📁 DevMind Claude Sync: Scanning local files...');
      const localFiles = await this.scanLocalFiles();
      console.log(`📊 DevMind Claude Sync: Found ${localFiles.length} local files to process`);

      console.log('☁️ DevMind Claude Sync: Fetching existing gist data...');
      const gistData = await this.fetchGist();
      console.log('📋 DevMind Claude Sync: Gist data fetched');

      console.log('🔍 DevMind Claude Sync: Checking for conflicts...');
      const conflicts = this.detectConflicts(localFiles, gistData);

      if (conflicts.length > 0) {
        console.log(`⚠️ DevMind Claude Sync: Found ${conflicts.length} conflicts`);
        this.status.conflicts = conflicts;
        await this.showConflictResolution(conflicts);
        return;
      }

      console.log('📤 DevMind Claude Sync: Uploading files to gists...');
      await this.uploadToGist(localFiles);
      console.log('✅ DevMind Claude Sync: Upload completed');

      console.log('📥 DevMind Claude Sync: Downloading from gists...');
      await this.downloadFromGist(gistData, localFiles);
      console.log('✅ DevMind Claude Sync: Download completed');

      this.status.lastSync = Date.now();
      console.log('🎉 DevMind Claude Sync: Sync completed successfully!');

    } catch (error) {
      console.error('💥 DevMind Claude Sync: Sync failed with error:', error);
      this.status.errors.push(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      vscode.window.showErrorMessage(`DevMind Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.status.issyncing = false;
      console.log('🏁 DevMind Claude Sync: Sync process ended');
    }
  }

  public async performPartialSync(fileType: string): Promise<void> {
    if (this.status.issyncing) {
      return;
    }

    // Ensure we're authenticated
    if (!(await this.ensureAuthenticated())) {
      this.status.errors.push('GitHub authentication required for sync');
      return;
    }

    this.status.issyncing = true;

    try {
      const localFiles = await this.scanLocalFilesForType(fileType);

      if (localFiles.length > 0) {
        await this.uploadFilesForType(fileType, localFiles);
        console.log(`Partial sync completed for ${fileType}: ${localFiles.length} files`);
      } else {
        console.log(`No files found for partial sync of ${fileType}`);
      }

      this.status.lastSync = Date.now();

    } catch (error) {
      this.status.errors.push(`Partial sync failed for ${fileType}: ${error instanceof Error ? error.message : String(error)}`);
      vscode.window.showErrorMessage(`DevMind ${fileType} sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.status.issyncing = false;
    }
  }

  private async scanLocalFilesForType(fileType: string): Promise<SyncableFile[]> {
    const files: SyncableFile[] = [];

    if (!fs.existsSync(this.claudeDir)) {
      return files;
    }

    const typeConfig = {
      settings: { paths: ['settings.json'], enabled: this.config.syncItems.settings },
      agents: { paths: ['agents/**', 'subagents.json', 'hooks.json'], enabled: this.config.syncItems.subagents || this.config.syncItems.hooks },
      commands: { paths: ['slash-commands/**'], enabled: this.config.syncItems.slashCommands },
      plugins: { paths: ['plugins/**'], enabled: this.config.syncItems.plugins },
      projects: { paths: ['**/CLAUDE.md'], enabled: this.config.syncItems.claudeMd }
    };

    const config = typeConfig[fileType as keyof typeof typeConfig];
    if (!config?.enabled) {
      return files;
    }

    for (const syncPath of config.paths) {
      try {
        const fullPath = path.join(this.claudeDir, syncPath);

        // Handle wildcard patterns
        if (syncPath.includes('*')) {
          await this.handleWildcardPattern(syncPath, files);
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
            } catch (readError) {
              console.warn('Could not read file:', fullPath, readError);
            }
          }
        }
      } catch (error) {
        console.warn('Error processing path:', syncPath, error);
      }
    }

    return files;
  }

  private async handleWildcardPattern(pattern: string, files: SyncableFile[]): Promise<void> {
    try {
      const baseDir = this.claudeDir;

      // Convert pattern to actual directory path
      if (pattern === 'agents/**') {
        const agentsDir = path.join(baseDir, 'agents');
        if (fs.existsSync(agentsDir)) {
          await this.scanDirectoryForFiles(agentsDir, files);
        }
      } else if (pattern === 'plugins/**') {
        const pluginsDir = path.join(baseDir, 'plugins');
        if (fs.existsSync(pluginsDir)) {
          await this.scanDirectoryForFiles(pluginsDir, files);
        }
      } else if (pattern === 'slash-commands/**') {
        const commandsDir = path.join(baseDir, 'slash-commands');
        if (fs.existsSync(commandsDir)) {
          await this.scanDirectoryForFiles(commandsDir, files);
        }
      } else if (pattern === '**/CLAUDE.md') {
        // Recursively search for CLAUDE.md files
        await this.scanForClaudeMdFiles(baseDir, files);
      }
    } catch (error) {
      console.warn(`Error handling wildcard pattern ${pattern}:`, error);
    }
  }

  private async scanDirectoryForFiles(dirPath: string, files: SyncableFile[]): Promise<void> {
    try {
      console.log(`🔍 DevMind Claude Sync: Scanning directory: ${dirPath}`);
      const items = fs.readdirSync(dirPath);
      console.log(`📂 DevMind Claude Sync: Found ${items.length} items in ${dirPath}:`, items);

      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          console.log(`📁 DevMind Claude Sync: Recursing into subdirectory: ${fullPath}`);
          // Recursively scan subdirectories
          await this.scanDirectoryForFiles(fullPath, files);
        } else if (stats.isFile()) {
          // Skip excluded files
          const relativePath = path.relative(this.claudeDir, fullPath);
          if (this.shouldExcludeFile(relativePath)) {
            console.log(`⚠️ DevMind Claude Sync: Excluding file: ${relativePath}`);
            continue;
          }

          // Skip .DS_Store files
          if (path.basename(fullPath) === '.DS_Store') {
            console.log(`⚠️ DevMind Claude Sync: Skipping .DS_Store file: ${relativePath}`);
            continue;
          }

          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');

            files.push({
              path: fullPath,
              relativePath,
              content,
              lastModified: stats.mtime.getTime(),
              hash
            });
            console.log(`✅ DevMind Claude Sync: Added file to scan: ${relativePath} (${content.length} chars)`);
          } catch (readError) {
            console.warn('Could not read file:', fullPath, readError);
          }
        }
      }
    } catch (error) {
      console.warn('Error scanning directory:', dirPath, error);
    }
  }

  private async scanForClaudeMdFiles(dirPath: string, files: SyncableFile[]): Promise<void> {
    try {
      const items = fs.readdirSync(dirPath);

      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          // Recursively scan subdirectories
          await this.scanForClaudeMdFiles(fullPath, files);
        } else if (stats.isFile() && item === 'CLAUDE.md') {
          const relativePath = path.relative(this.claudeDir, fullPath);

          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');

            files.push({
              path: fullPath,
              relativePath,
              content,
              lastModified: stats.mtime.getTime(),
              hash
            });
          } catch (readError) {
            console.warn('Could not read CLAUDE.md file:', fullPath, readError);
          }
        }
      }
    } catch (error) {
      console.warn('Error scanning for CLAUDE.md files:', dirPath, error);
    }
  }

  private async uploadFilesForType(fileType: string, files: SyncableFile[]): Promise<void> {
    if (!this.githubSession || files.length === 0) {
      return;
    }

    // Convert files to gist format
    const gistFiles: { [filename: string]: { content: string } } = {};
    for (const file of files) {
      const safeFilename = file.relativePath.replace(/\\/g, '/');
      gistFiles[safeFilename] = { content: file.content };
    }

    const gistId = this.config.gists[fileType as keyof typeof this.config.gists];

    if (gistId) {
      // Update existing gist
      await this.updateExistingGist(gistId, gistFiles);
    } else {
      // Create new gist
      await this.createGistForType(fileType, gistFiles);
    }
  }

  private async scanLocalFiles(): Promise<SyncableFile[]> {
    const files: SyncableFile[] = [];

    // Check if Claude directory exists
    if (!fs.existsSync(this.claudeDir)) {
      console.log('Claude directory does not exist:', this.claudeDir);
      return files;
    }

    // Dynamically discover all subdirectories in .claude folder
    const subdirectories = fs.readdirSync(this.claudeDir).filter(item => {
      const fullPath = path.join(this.claudeDir, item);
      return fs.statSync(fullPath).isDirectory();
    });

    console.log(`Found Claude subdirectories:`, subdirectories);

    // Scan each subdirectory recursively
    for (const subdir of subdirectories) {
      await this.scanDirectoryRecursively(path.join(this.claudeDir, subdir), files);
    }

    // Also scan root level files in .claude directory
    const rootFiles = fs.readdirSync(this.claudeDir).filter(item => {
      const fullPath = path.join(this.claudeDir, item);
      return fs.statSync(fullPath).isFile();
    });

    for (const rootFile of rootFiles) {
      const fullPath = path.join(this.claudeDir, rootFile);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        const relativePath = path.relative(this.claudeDir, fullPath);

        files.push({
          path: fullPath,
          relativePath,
          content,
          lastModified: fs.statSync(fullPath).mtime.getTime(),
          hash
        });

        console.log('Found root file to sync:', relativePath);
      } catch (readError) {
        console.warn('Could not read root file:', fullPath, readError);
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

  private async scanDirectoryRecursively(dirPath: string, files: SyncableFile[]): Promise<void> {
    try {
      const items = fs.readdirSync(dirPath);

      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          // Recursively scan subdirectories
          await this.scanDirectoryRecursively(fullPath, files);
        } else if (stats.isFile()) {
          // Skip excluded patterns
          const relativePath = path.relative(this.claudeDir, fullPath);
          if (this.shouldExcludeFile(relativePath)) {
            console.log('Excluding file:', relativePath);
            continue;
          }

          // Skip .DS_Store files specifically
          if (path.basename(fullPath) === '.DS_Store') {
            console.log('Excluding .DS_Store file:', relativePath);
            continue;
          }

          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');

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
      }
    } catch (error) {
      console.warn('Error scanning directory:', dirPath, error);
    }
  }

  private shouldExcludeFile(relativePath: string): boolean {
    for (const pattern of this.config.excludePatterns) {
      if (this.matchesPattern(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    // Simple pattern matching for common cases
    if (pattern === '**/*.jsonl') {
      return filePath.endsWith('.jsonl');
    }
    if (pattern === '**/*.lock') {
      return filePath.endsWith('.lock');
    }
    if (pattern.endsWith('/**')) {
      const dirName = pattern.replace('/**', '');
      return filePath.startsWith(dirName + '/');
    }

    // Fallback to regex for complex patterns
    const regexPattern = pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\./g, '\\.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(filePath);
  }

  private async fetchGist(): Promise<GistData | null> {
    // For now, fetch from settings gist as primary
    const gistId = this.config.gists.settings;
    if (!gistId || !this.githubSession) {
      return null;
    }

    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
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
    console.log(`📤 DevMind Claude Sync: uploadToGist called with ${files.length} files`);

    if (!this.githubSession) {
      throw new Error('GitHub authentication required');
    }

    // Skip if no files to sync
    if (files.length === 0) {
      console.log('⚠️ DevMind Claude Sync: No files to sync - uploadToGist returning early');
      return;
    }

    console.log('📁 DevMind Claude Sync: Files to process:');
    files.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file.relativePath} (${file.content.length} chars)`);
    });

    // Group files dynamically by their top-level directory
    const fileGroups: { [groupName: string]: { [filename: string]: { content: string } } } = {};

    console.log(`📊 DevMind Claude Sync: Grouping ${files.length} files...`);
    for (const file of files) {
      console.log(`🔍 DevMind Claude Sync: Processing file: ${file.relativePath}`);
      const safeFilename = file.relativePath.replace(/\\/g, '/');
      const content = file.content || '';

      if (!safeFilename || typeof content !== 'string') {
        console.log(`⚠️ DevMind Claude Sync: Skipping invalid file: ${safeFilename}`);
        continue;
      }

      // Skip empty files (GitHub Gists require non-empty content)
      if (content.trim().length === 0) {
        console.log(`⚠️ DevMind Claude Sync: Skipping empty file: ${safeFilename}`);
        continue;
      }

      // Determine group name based on top-level directory or file location
      let groupName: string;
      const pathParts = safeFilename.split('/');

      if (pathParts.length > 1) {
        // File is in a subdirectory - use the first directory as group name
        groupName = pathParts[0];
      } else {
        // File is in root .claude directory - use 'settings' as default group
        groupName = 'settings';
      }

      // Initialize group if it doesn't exist
      if (!fileGroups[groupName]) {
        fileGroups[groupName] = {};
        console.log(`📂 DevMind Claude Sync: Created group '${groupName}'`);
      }

      // Sanitize filename for GitHub Gist compatibility
      const gistFilename = this.sanitizeGistFilename(safeFilename);
      if (!gistFilename) {
        console.warn(`⚠️ DevMind Claude Sync: Skipping file with invalid name: '${safeFilename}'`);
        continue;
      }

      // Check for filename collisions
      if (fileGroups[groupName][gistFilename]) {
        console.warn(`⚠️ DevMind Claude Sync: Filename collision! '${safeFilename}' and existing file both map to '${gistFilename}' in group '${groupName}'`);
        // Make the filename unique by adding a suffix
        let counter = 1;
        let uniqueFilename = gistFilename;
        while (fileGroups[groupName][uniqueFilename]) {
          const dotIndex = gistFilename.lastIndexOf('.');
          if (dotIndex > 0) {
            uniqueFilename = gistFilename.substring(0, dotIndex) + `_${counter}` + gistFilename.substring(dotIndex);
          } else {
            uniqueFilename = `${gistFilename}_${counter}`;
          }
          counter++;
        }
        console.log(`📝 DevMind Claude Sync: Resolved collision by using '${uniqueFilename}' instead`);
        fileGroups[groupName][uniqueFilename] = { content };
      } else {
        fileGroups[groupName][gistFilename] = { content };
      }

      console.log(`📝 DevMind Claude Sync: Added '${safeFilename}' as '${gistFilename}' to group '${groupName}'`);
    }

    console.log('📊 DevMind Claude Sync: File groups created:');
    for (const [groupName, groupFiles] of Object.entries(fileGroups)) {
      console.log(`  📂 Group '${groupName}': ${Object.keys(groupFiles).length} files`);
      Object.keys(groupFiles).forEach(filename => {
        console.log(`    - ${filename}`);
      });
    }

    // Upload each group to its respective gist
    console.log('🚀 DevMind Claude Sync: Starting gist uploads...');
    for (const [groupType, groupFiles] of Object.entries(fileGroups)) {
      if (Object.keys(groupFiles).length === 0) {
        console.log(`⚠️ DevMind Claude Sync: Skipping empty group '${groupType}'`);
        continue;
      }

      console.log(`📤 DevMind Claude Sync: Processing group '${groupType}' with ${Object.keys(groupFiles).length} files`);

      let gistId = this.config.gists[groupType as keyof typeof this.config.gists];
      console.log(`🔍 DevMind Claude Sync: Existing gist ID for '${groupType}':`, gistId || 'none');

      if (gistId) {
        // Update existing gist
        console.log(`🔄 DevMind Claude Sync: Updating existing gist ${gistId} for group '${groupType}'`);
        await this.updateExistingGist(gistId, groupFiles);
        console.log(`✅ DevMind Claude Sync: Updated gist ${gistId} for group '${groupType}'`);
      } else {
        // Create new gist for this group
        console.log(`➕ DevMind Claude Sync: Creating new gist for group '${groupType}'`);
        const newGistId = await this.createGistForType(groupType, groupFiles);
        if (newGistId) {
          console.log(`✅ DevMind Claude Sync: Created new gist ${newGistId} for group '${groupType}'`);
          // Store the new gist ID in config for future use
          await this.updateGistIdInConfig(groupType, newGistId);
          console.log(`💾 DevMind Claude Sync: Saved gist ID to config for group '${groupType}'`);
        } else {
          console.error(`❌ DevMind Claude Sync: Failed to create gist for group '${groupType}'`);
        }
      }
    }

    console.log('🎉 DevMind Claude Sync: All gist uploads completed');
  }

  private async updateExistingGist(gistId: string, files: { [filename: string]: { content: string } }): Promise<void> {
    const gistData = {
      files
    };

    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.githubSession!.accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'VS Code Extension DevMind'
      },
      body: JSON.stringify(gistData)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to update gist ${gistId}: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    console.log(`Updated gist ${gistId} with ${Object.keys(files).length} files`);
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

  private sanitizeGistFilename(filename: string): string | null {
    if (!filename || typeof filename !== 'string') {
      return null;
    }

    // GitHub Gist file name restrictions:
    // - Cannot be empty
    // - Cannot contain certain characters
    // - Cannot start with a dot (.)
    // - Should be reasonable length

    // Replace directory separators with underscores to flatten the structure
    let sanitized = filename.replace(/[\/\\]/g, '_');

    // Remove or replace invalid characters
    sanitized = sanitized.replace(/[<>:"|?*]/g, '-');

    // Ensure it doesn't start with a dot
    if (sanitized.startsWith('.')) {
      sanitized = 'file_' + sanitized;
    }

    // Ensure it's not empty after sanitization
    if (!sanitized.trim()) {
      return null;
    }

    // Truncate if too long (GitHub allows up to 255 characters)
    if (sanitized.length > 255) {
      const extension = sanitized.substring(sanitized.lastIndexOf('.'));
      const nameWithoutExt = sanitized.substring(0, sanitized.lastIndexOf('.'));
      sanitized = nameWithoutExt.substring(0, 255 - extension.length) + extension;
    }

    return sanitized;
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