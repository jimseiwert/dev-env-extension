import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EnvironmentService, EnvVariable, RemoteSecret } from './envService';

export class EnvironmentViewProvider implements vscode.TreeDataProvider<EnvironmentItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<EnvironmentItem | undefined | null | void> = new vscode.EventEmitter<EnvironmentItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<EnvironmentItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private envService: EnvironmentService;
  private environmentFiles: string[] = [];
  private remoteSecrets: RemoteSecret[] = [];
  private localVariables: Set<string> = new Set();
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private initialized: boolean = false;
  private refreshTimeout: NodeJS.Timeout | undefined;
  private remoteDataLoadedCallback?: () => Promise<void>;

  constructor(envService: EnvironmentService) {
    this.envService = envService;
    // Don't call initialize() here - let extension.ts handle it
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Only load local data during initialization - no API calls
      this.environmentFiles = await this.findEnvironmentFiles();
      await this.buildLocalVariablesSet();

      // Mark as initialized but don't set up watchers yet - that will be done later
      this.initialized = true;

      console.log('Environment view provider initialized (no API calls)');

      // Fire initial tree data change to show initialized state
      this._onDidChangeTreeData.fire();
    } catch (error) {
      console.error('Error initializing environment view provider:', error);
      // Still mark as initialized to prevent retry loops
      this.initialized = true;
      // Fire tree data change to show empty/error state
      this._onDidChangeTreeData.fire();
    }
  }

  public async loadRemoteDataAndSetupWatchers(): Promise<void> {
    if (!this.initialized) {
      throw new Error('Must call initialize() first');
    }

    try {
      console.log('Loading remote 1Password data...');

      // Check if 1Password is configured
      const isConfigured = await this.envService.isConfigured();

      if (isConfigured) {
        // Make the single API call to get remote secrets
        try {
          this.remoteSecrets = await this.envService.getRemoteSecrets();
          console.log(`Loaded ${this.remoteSecrets.length} remote secrets`);
        } catch (error) {
          console.error('Error fetching remote secrets:', error);
          this.remoteSecrets = [];
        }
      } else {
        this.remoteSecrets = [];
        console.log('1Password not configured, no remote secrets loaded');
      }

      // Now set up file watchers after we have complete state
      this.setupFileWatcher();

      console.log('Remote data loaded and watchers set up');

      // Fire tree data change to show complete data
      this._onDidChangeTreeData.fire();

      // Trigger any additional initialization that depends on remote data
      this.onRemoteDataLoaded();
    } catch (error) {
      console.error('Error loading remote data:', error);
      throw error;
    }
  }

  public getRemoteSecrets(): RemoteSecret[] {
    return this.remoteSecrets;
  }

  public setRemoteDataLoadedCallback(callback: () => Promise<void>): void {
    this.remoteDataLoadedCallback = callback;
  }

  private async onRemoteDataLoaded(): Promise<void> {
    if (this.remoteDataLoadedCallback) {
      try {
        await this.remoteDataLoadedCallback();
      } catch (error) {
        console.error('Error in remote data loaded callback:', error);
      }
    }
  }

  private setupFileWatcher(): void {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    // Clean up existing watcher if any
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }

    // Watch for .env files
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/.env*');
    this.fileWatcher.onDidChange(() => {
      console.log('File changed, refreshing environment view...');
      this.debouncedRefresh();
    });
    this.fileWatcher.onDidCreate(() => {
      console.log('File created, refreshing environment view...');
      this.debouncedRefresh();
    });
    this.fileWatcher.onDidDelete(() => {
      console.log('File deleted, refreshing environment view...');
      this.debouncedRefresh();
    });
  }

  async refresh(): Promise<void> {
    await this.refreshData();
    this._onDidChangeTreeData.fire();
  }

  private debouncedRefresh(): void {
    // Clear any existing timeout
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }

    // Set a new timeout to refresh after 1 second of no activity
    this.refreshTimeout = setTimeout(async () => {
      await this.refresh();
    }, 1000);
  }

  private async refreshData(): Promise<void> {
    // Check if 1Password is configured
    const isConfigured = await this.envService.isConfigured();

    if (isConfigured) {
      // Fetch remote 1Password secrets
      try {
        this.remoteSecrets = await this.envService.getRemoteSecrets();
      } catch (error) {
        console.error('Error fetching remote secrets:', error);
        this.remoteSecrets = [];
      }
    } else {
      this.remoteSecrets = [];
    }

    // Find .env files
    this.environmentFiles = await this.findEnvironmentFiles();

    // Build local variables set for comparison
    await this.buildLocalVariablesSet();
  }

  private async buildLocalVariablesSet(): Promise<void> {
    this.localVariables.clear();

    for (const filePath of this.environmentFiles) {
      const vars = await this.parseEnvFile(filePath);
      vars.forEach(variable => {
        // With codespaces secrets, we use the exact key name
        this.localVariables.add(variable.key);
      });
    }
  }

  private async findEnvironmentFiles(): Promise<string[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    const envFiles: string[] = [];

    for (const folder of vscode.workspace.workspaceFolders) {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/.env*'),
        '**/node_modules/**'
      );

      envFiles.push(...files.map(file => file.fsPath));
    }

    return envFiles;
  }

  getTreeItem(element: EnvironmentItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EnvironmentItem): Promise<EnvironmentItem[]> {
    if (!element) {
      // Root level items
      return this.getRootItems();
    }

    if (element.contextValue === 'envFile') {
      // Environment variables within a file
      return this.getEnvironmentVariables(element.resourceUri!.fsPath);
    }

    return [];
  }

  private async getRootItems(): Promise<EnvironmentItem[]> {
    const items: EnvironmentItem[] = [];

    // If not initialized yet, show loading message to prevent API calls
    if (!this.initialized) {
      const loadingItem = new EnvironmentItem(
        '⏳ Loading...',
        vscode.TreeItemCollapsibleState.None
      );
      loadingItem.contextValue = 'loading';
      loadingItem.tooltip = 'Loading environment configuration...';
      loadingItem.iconPath = new vscode.ThemeIcon('loading~spin');
      items.push(loadingItem);
      return items;
    }

    // Only show 1Password status if not configured (for setup guidance)
    const isConfigured = await this.envService.isConfigured();
    if (!isConfigured) {
      const notConfiguredItem = new EnvironmentItem(
        '❌ 1Password Not Configured',
        vscode.TreeItemCollapsibleState.None
      );
      notConfiguredItem.contextValue = 'onePasswordNotConfigured';
      notConfiguredItem.tooltip = 'Configure 1Password Connect to sync environment variables securely';
      notConfiguredItem.iconPath = new vscode.ThemeIcon('warning');
      items.push(notConfiguredItem);
    }

    // Environment files
    if (this.environmentFiles.length > 0) {
      for (const filePath of this.environmentFiles) {
        const fileName = path.basename(filePath);
        const relativePath = vscode.workspace.asRelativePath(filePath);

        // Get sync status for this file
        const fileSecrets = await this.getFileSecretStatus(filePath);
        const totalVariables = fileSecrets.synced.length + fileSecrets.conflicted.length + fileSecrets.missing.length + fileSecrets.localOnly.length;
        const syncedCount = fileSecrets.synced.length;
        const conflictCount = fileSecrets.conflicted.length;
        const missingCount = fileSecrets.missing.length;
        const localOnlyCount = fileSecrets.localOnly.length;

        let statusSummary = `${syncedCount} synced`;
        if (conflictCount > 0) statusSummary += `, ${conflictCount} conflicts`;
        if (missingCount > 0) statusSummary += `, ${missingCount} missing`;
        if (localOnlyCount > 0) statusSummary += `, ${localOnlyCount} local-only`;

        const fileItem = new EnvironmentItem(
          `📄 ${fileName}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        fileItem.contextValue = 'envFile';
        fileItem.resourceUri = vscode.Uri.file(filePath);
        fileItem.description = totalVariables > 0 ? `(${statusSummary})` : (relativePath !== fileName ? path.dirname(relativePath) : undefined);
        fileItem.tooltip = `Environment file: ${relativePath}\n${statusSummary}\nTotal variables: ${totalVariables}`;

        items.push(fileItem);
      }
    } else {
      const noFilesItem = new EnvironmentItem(
        '📝 No .env files found',
        vscode.TreeItemCollapsibleState.None
      );
      noFilesItem.contextValue = 'noEnvFiles';
      noFilesItem.tooltip = 'Create a .env file to start syncing environment variables';
      items.push(noFilesItem);
    }

    // Sort items for consistent ordering
    // 1Password status first (if not configured), then .env files alphabetically
    items.sort((a, b) => {
      // 1Password not configured status items always come first
      if (a.contextValue === 'onePasswordNotConfigured' && b.contextValue !== 'onePasswordNotConfigured') {
        return -1;
      }
      if (b.contextValue === 'onePasswordNotConfigured' && a.contextValue !== 'onePasswordNotConfigured') {
        return 1;
      }

      // .env files sorted alphabetically by filename
      if (a.contextValue === 'envFile' && b.contextValue === 'envFile') {
        return a.label!.localeCompare(b.label!);
      }

      // Other items maintain their relative order
      return 0;
    });

    return items;
  }

  private async getEnvironmentVariables(filePath: string): Promise<EnvironmentItem[]> {
    try {
      const fileSecrets = await this.getFileSecretStatus(filePath);
      const variables: EnvironmentItem[] = [];

      // Show synced secrets (values match exactly)
      for (const localVar of fileSecrets.synced) {
        const remoteSecret = this.remoteSecrets.find(s => s.name === localVar.key);
        const remoteUpdated = remoteSecret ? new Date(remoteSecret.updated_at) : null;

        const varItem = new EnvironmentItem(
          `✅ ${localVar.key}`,
          vscode.TreeItemCollapsibleState.None
        );
        varItem.contextValue = 'syncedSecret';
        varItem.description = 'Values match 1Password';
        varItem.tooltip = `${localVar.key}=${this.maskValue(localVar.value)}\nLocal and 1Password values match exactly\n${remoteUpdated ? `1Password updated: ${this.getRelativeTime(remoteUpdated)}` : ''}`;

        // Store data for commands
        (varItem as any).envKey = localVar.key;
        (varItem as any).envValue = localVar.value;
        (varItem as any).filePath = filePath;
        (varItem as any).status = 'synced';

        variables.push(varItem);
      }

      // Show conflicted secrets (same name/file but different values)
      for (const conflictVar of fileSecrets.conflicted) {
        const remoteUpdated = conflictVar.remoteSecret ? new Date(conflictVar.remoteSecret.updated_at) : null;

        const varItem = new EnvironmentItem(
          `⚠️ ${conflictVar.key}`,
          vscode.TreeItemCollapsibleState.None
        );
        varItem.contextValue = 'conflictedSecret';
        varItem.description = 'Values differ - conflict!';
        varItem.tooltip = `${conflictVar.key} has different values:\nLocal: ${this.maskValue(conflictVar.value)}\n1Password: ${this.maskValue(conflictVar.remoteValue || 'unknown')}\n${remoteUpdated ? `1Password updated: ${this.getRelativeTime(remoteUpdated)}` : ''}\nClick to resolve conflict`;

        // Store data for commands
        (varItem as any).envKey = conflictVar.key;
        (varItem as any).envValue = conflictVar.value;
        (varItem as any).itemId = conflictVar.remoteSecret.itemId;
        (varItem as any).remoteValue = conflictVar.remoteValue;
        (varItem as any).filePath = filePath;
        (varItem as any).status = 'conflicted';

        variables.push(varItem);
      }

      // Show missing secrets (exist in repo but not in this file)
      for (const remoteSecret of fileSecrets.missing) {
        const remoteUpdated = new Date(remoteSecret.updated_at);
        const originalFileName = path.basename(remoteSecret.filePath);

        const varItem = new EnvironmentItem(
          `💾 ${remoteSecret.name}`,
          vscode.TreeItemCollapsibleState.None
        );
        varItem.contextValue = 'missingSecret';
        varItem.description = `From ${originalFileName} • Updated ${this.getRelativeTime(remoteUpdated)}`;
        varItem.tooltip = `${remoteSecret.name} exists in ${originalFileName}\nClick to copy to this file`;

        // Store data for commands
        (varItem as any).envKey = remoteSecret.name;
        (varItem as any).itemId = remoteSecret.itemId;
        (varItem as any).filePath = filePath;
        (varItem as any).originalFilePath = remoteSecret.filePath;
        (varItem as any).status = 'missing';

        variables.push(varItem);
      }

      // Show local-only secrets (exist in file but not in remote)
      for (const localVar of fileSecrets.localOnly) {
        const varItem = new EnvironmentItem(
          `🔑 ${localVar.key} ⬆️`,
          vscode.TreeItemCollapsibleState.None
        );
        varItem.contextValue = 'localOnlySecret';
        varItem.description = `Local only • File ${this.getRelativeTime(fileSecrets.fileModifiedTime)}`;
        varItem.tooltip = `${localVar.key}=${this.maskValue(localVar.value)}\nExists locally but not in 1Password\nFile modified: ${this.getRelativeTime(fileSecrets.fileModifiedTime)}\nClick to upload to 1Password`;

        // Store data for commands
        (varItem as any).envKey = localVar.key;
        (varItem as any).envValue = localVar.value;
        (varItem as any).filePath = filePath;
        (varItem as any).status = 'localOnly';

        variables.push(varItem);
      }

      // Sort variables for consistent ordering
      // Order: synced first, then conflicted, then missing, then local-only
      // Within each group, sort alphabetically by key
      variables.sort((a, b) => {
        const statusOrder: Record<string, number> = { 'synced': 0, 'conflicted': 1, 'missing': 2, 'localOnly': 3 };
        const aStatus = (a as any).status;
        const bStatus = (b as any).status;

        // First sort by status group
        const aOrder = statusOrder[aStatus] ?? 999;
        const bOrder = statusOrder[bStatus] ?? 999;
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }

        // Then sort alphabetically within the same status
        const aKey = (a as any).envKey;
        const bKey = (b as any).envKey;
        return aKey.localeCompare(bKey);
      });

      return variables;
    } catch (error) {
      console.error('Error reading environment file:', error);
      return [];
    }
  }

  private maskValue(value: string): string {
    if (!value || value.length <= 8) {
      return value ? '*'.repeat(value.length) : '';
    }
    return value.substring(0, 2) + '*'.repeat(value.length - 4) + value.substring(value.length - 2);
  }

  private async checkForVariableConflicts(secretName: string, newItemId: string): Promise<{filePath: string, currentValue: string}[]> {
    const conflicts: {filePath: string, currentValue: string}[] = [];

    // Get the value we're about to add
    const newSecretValue = await this.envService.getSecretValue(newItemId);
    if (newSecretValue === null) {
      return conflicts; // Can't compare if we can't get the new value
    }

    // Check each file for the variable
    for (const filePath of this.environmentFiles) {
      try {
        const fileVars = await this.parseEnvFile(filePath);
        const existingVar = fileVars.find(v => v.key === secretName);

        if (existingVar && existingVar.value !== newSecretValue && existingVar.value !== '<FILL_IN_VALUE>' && existingVar.value !== '') {
          conflicts.push({
            filePath,
            currentValue: this.maskValue(existingVar.value)
          });
        }
      } catch (error) {
        console.error(`Error checking conflicts in ${filePath}:`, error);
      }
    }

    return conflicts;
  }

  private async showVariableConflictResolution(secretName: string, itemId: string, conflicts: {filePath: string, currentValue: string}[]): Promise<void> {
    const newSecretValue = await this.envService.getSecretValue(itemId);
    if (newSecretValue === null) {
      vscode.window.showErrorMessage('Failed to retrieve new secret value from 1Password');
      return;
    }

    const options = [
      {
        label: `📥 Add to new file only`,
        description: `Create/select file without conflicts`,
        action: 'new-file'
      },
      {
        label: `🔄 Update all files with 1Password value`,
        description: `Replace all existing values with: ${this.maskValue(newSecretValue)}`,
        action: 'update-all'
      },
      {
        label: `🔍 Choose files individually`,
        description: `Select which files to update`,
        action: 'choose-files'
      },
      {
        label: `❌ Cancel`,
        description: `Don't make any changes`,
        action: 'cancel'
      }
    ];

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: `How would you like to handle the "${secretName}" conflicts?`
    });

    if (!selected || selected.action === 'cancel') {
      return;
    }

    switch (selected.action) {
      case 'new-file':
        await this.addToNonConflictingFile(secretName, itemId, conflicts);
        break;
      case 'update-all':
        await this.updateAllFiles(secretName, itemId);
        break;
      case 'choose-files':
        await this.selectFilesToUpdate(secretName, itemId, conflicts);
        break;
    }
  }

  private async addToNonConflictingFile(secretName: string, itemId: string, conflicts: {filePath: string, currentValue: string}[]): Promise<void> {
    const conflictPaths = new Set(conflicts.map(c => c.filePath));
    const nonConflictingFiles = this.environmentFiles.filter(f => !conflictPaths.has(f));

    if (nonConflictingFiles.length === 0) {
      // Create new file
      await this.createNewEnvFileWithSecret(secretName, itemId);
      return;
    }

    if (nonConflictingFiles.length === 1) {
      await this.envService.downloadSecretToLocalFile(nonConflictingFiles[0], secretName, itemId);
      await this.refresh();
      return;
    }

    // Let user choose from non-conflicting files
    const options = nonConflictingFiles.map(filePath => ({
      label: path.basename(filePath),
      description: vscode.workspace.asRelativePath(filePath),
      filePath
    }));

    // Add option to create new file
    options.push({
      label: '➕ Create new .env file',
      description: 'Create a new .env file for this variable',
      filePath: ''
    });

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: `Select file to add ${secretName} (no conflicts)`
    });

    if (selected) {
      if (selected.filePath === '') {
        await this.createNewEnvFileWithSecret(secretName, itemId);
      } else {
        await this.envService.downloadSecretToLocalFile(selected.filePath, secretName, itemId);
        await this.refresh();
      }
    }
  }

  private async updateAllFiles(secretName: string, itemId: string): Promise<void> {
    let successCount = 0;
    const totalFiles = this.environmentFiles.length;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Updating ${secretName} in all files...`,
      cancellable: false
    }, async (progress) => {
      for (const filePath of this.environmentFiles) {
        try {
          await this.envService.downloadSecretToLocalFile(filePath, secretName, itemId);
          successCount++;
          progress.report({
            message: `${successCount}/${totalFiles} files updated`,
            increment: (1 / totalFiles) * 100
          });
        } catch (error) {
          console.error(`Failed to update ${secretName} in ${filePath}:`, error);
        }
      }
    });

    if (successCount === totalFiles) {
      vscode.window.showInformationMessage(`✅ Updated ${secretName} in all ${totalFiles} files with 1Password value`);
    } else {
      vscode.window.showWarningMessage(`⚠️ Updated ${secretName} in ${successCount}/${totalFiles} files. Some files had errors.`);
    }

    await this.refresh();
  }

  private async selectFilesToUpdate(secretName: string, itemId: string, conflicts: {filePath: string, currentValue: string}[]): Promise<void> {
    const allOptions = this.environmentFiles.map(filePath => {
      const conflict = conflicts.find(c => c.filePath === filePath);
      return {
        label: path.basename(filePath),
        description: conflict
          ? `${vscode.workspace.asRelativePath(filePath)} - Current: ${conflict.currentValue} (CONFLICT)`
          : vscode.workspace.asRelativePath(filePath),
        picked: !conflict, // Pre-select non-conflicting files
        filePath
      };
    });

    const selected = await vscode.window.showQuickPick(allOptions, {
      placeHolder: `Select files to update with ${secretName}`,
      canPickMany: true
    });

    if (selected && selected.length > 0) {
      let successCount = 0;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Updating ${secretName} in selected files...`,
        cancellable: false
      }, async (progress) => {
        for (const option of selected) {
          try {
            await this.envService.downloadSecretToLocalFile(option.filePath, secretName, itemId);
            successCount++;
            progress.report({
              message: `${successCount}/${selected.length} files updated`,
              increment: (1 / selected.length) * 100
            });
          } catch (error) {
            console.error(`Failed to update ${secretName} in ${option.filePath}:`, error);
          }
        }
      });

      if (successCount === selected.length) {
        vscode.window.showInformationMessage(`✅ Updated ${secretName} in ${successCount} selected files`);
      } else {
        vscode.window.showWarningMessage(`⚠️ Updated ${secretName} in ${successCount}/${selected.length} selected files. Some files had errors.`);
      }

      await this.refresh();
    }
  }

  // Command handlers
  async syncAllEnvironmentVariables(): Promise<void> {
    const isConfigured = await this.envService.isConfigured();
    if (!isConfigured) {
      vscode.window.showErrorMessage('1Password not configured. Please configure 1Password Connect to sync environment variables.');
      return;
    }

    const envFiles = this.environmentFiles;
    if (envFiles.length === 0) {
      vscode.window.showInformationMessage('No .env files found in the workspace.');
      return;
    }

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Syncing all environment variables to 1Password...',
        cancellable: false
      }, async (progress) => {
        let syncedCount = 0;
        let totalCount = 0;

        // Count total variables
        for (const filePath of envFiles) {
          const vars = await this.parseEnvFile(filePath);
          totalCount += vars.length;
        }

        // Sync all variables
        for (const filePath of envFiles) {
          const vars = await this.parseEnvFile(filePath);
          for (const variable of vars) {
            try {
              await this.envService.syncSingleVariable(variable.key, variable.value, filePath);
              syncedCount++;
              progress.report({
                message: `${syncedCount}/${totalCount} variables synced`,
                increment: (1 / totalCount) * 100
              });
            } catch (error) {
              console.error(`Failed to sync ${variable.key}:`, error);
            }
          }
        }
      });

      vscode.window.showInformationMessage('✅ All environment variables synced to 1Password successfully!');

    } catch (error) {
      vscode.window.showErrorMessage(`Failed to sync environment variables: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async syncEnvironmentVariable(item: EnvironmentItem): Promise<void> {
    const isConfigured = await this.envService.isConfigured();
    if (!isConfigured) {
      vscode.window.showErrorMessage('1Password not configured.');
      return;
    }

    const key = (item as any).envKey;
    const value = (item as any).envValue;
    const filePath = (item as any).filePath;

    if (!key || !value || !filePath) {
      vscode.window.showErrorMessage('Invalid environment variable data.');
      return;
    }

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Syncing ${key} to 1Password...`,
        cancellable: false
      }, async () => {
        await this.envService.syncSingleVariable(key, value, filePath);
      });

      vscode.window.showInformationMessage(`✅ ${key} synced to 1Password successfully!`);

    } catch (error) {
      vscode.window.showErrorMessage(`Failed to sync ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async parseEnvFile(filePath: string): Promise<EnvVariable[]> {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const variables: EnvVariable[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const equalIndex = trimmed.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmed.substring(0, equalIndex).trim();
          const value = trimmed.substring(equalIndex + 1).trim();
          const cleanValue = value.replace(/^["']|["']$/g, '');
          variables.push({ key, value: cleanValue });
        }
      }
    }

    return variables;
  }

  private getRemoteOnlySecretsList(): RemoteSecret[] {
    return this.remoteSecrets.filter(secret => {
      // With 1Password secrets, just compare the exact key name
      return !this.localVariables.has(secret.name);
    });
  }

  private async getRemoteOnlySecrets(): Promise<EnvironmentItem[]> {
    const remoteOnlySecrets = this.getRemoteOnlySecretsList();
    const items: EnvironmentItem[] = [];

    for (const secret of remoteOnlySecrets) {
      const secretItem = new EnvironmentItem(
        `☁️ ${secret.name}`,
        vscode.TreeItemCollapsibleState.None
      );
      secretItem.contextValue = 'remoteSecret';
      secretItem.description = '1Password Secret';
      secretItem.tooltip = `1Password secret: ${secret.name}\nClick to add to local .env file`;

      // Store secret info for commands
      (secretItem as any).secretName = secret.name;
      (secretItem as any).itemId = secret.itemId;

      items.push(secretItem);
    }

    return items;
  }

  private async getFileSecretStatus(filePath: string) {
    const localVars = await this.parseEnvFile(filePath);
    const fileStats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    const fileModifiedTime = new Date(fileStats.mtime);

    // With the new architecture, we need to find file-specific remote secrets
    const synced: any[] = [];
    const conflicted: any[] = [];
    const missing: any[] = [];
    const localOnly: any[] = [];

    // Check each local variable
    for (const localVar of localVars) {
      // Find 1Password entries that match this variable name AND this specific file
      const matchingRemoteSecrets = this.remoteSecrets.filter(rs =>
        rs.name === localVar.key && rs.filePath === filePath
      );

      if (matchingRemoteSecrets.length > 0) {
        // Find the one that matches the value (if any)
        let found = false;
        let hasConflict = false;
        for (const remoteSecret of matchingRemoteSecrets) {
          try {
            const remoteValue = await this.envService.getSecretValue(remoteSecret.itemId);
            if (remoteValue === localVar.value) {
              synced.push({
                ...localVar,
                remoteSecret
              });
              found = true;
              break;
            } else if (remoteValue !== null) {
              // Values differ - this is a conflict
              conflicted.push({
                ...localVar,
                remoteSecret,
                remoteValue
              });
              hasConflict = true;
              break;
            }
          } catch (error) {
            console.error(`Error getting remote value for ${localVar.key}:`, error);
          }
        }

        if (!found && !hasConflict) {
          // No remote value could be retrieved
          localOnly.push(localVar);
        }
      } else {
        // No 1Password entry exists for this variable in this file
        localOnly.push(localVar);
      }
    }

    // Find remote secrets from the same repo that could be added to this file
    // This provides "copy/paste" functionality from other files in the same repo
    for (const remoteSecret of this.remoteSecrets) {
      // Skip secrets that are already handled (synced, conflicted, or for this exact file)
      const localVar = localVars.find(lv => lv.key === remoteSecret.name);
      const isAlreadyHandled = localVar !== undefined;

      if (!isAlreadyHandled) {
        // This is a secret from the repo that doesn't exist in this file yet
        missing.push(remoteSecret);
      }
    }

    return {
      synced,
      conflicted,
      missing,
      localOnly,
      fileModifiedTime
    };
  }

  private getValueStatus(localValue: string, secretName: string): { status: string, description: string } {
    const remoteSecret = this.remoteSecrets.find(s => s.name === secretName);
    if (!remoteSecret) {
      return { status: 'local-only', description: 'Local only' };
    }

    // We can't compare actual values since 1Password doesn't return secret values in list operations
    // But we can compare timestamps and assume values match if we're in sync
    const remoteUpdated = new Date(remoteSecret.updated_at);

    return {
      status: 'synced',
      description: `1Password updated ${this.getRelativeTime(remoteUpdated)}`
    };
  }

  private getRelativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;

    return date.toLocaleDateString();
  }


  // Command to add a remote secret to local .env file
  async addRemoteSecretToLocal(item: EnvironmentItem): Promise<void> {
    const secretName = (item as any).secretName;
    const itemId = (item as any).itemId;

    if (!secretName || !itemId) {
      vscode.window.showErrorMessage('Invalid remote secret data.');
      return;
    }

    // If no .env files exist, create one
    if (this.environmentFiles.length === 0) {
      await this.createNewEnvFileWithSecret(secretName, itemId);
      return;
    }

    // Check for potential conflicts across files
    const conflicts = await this.checkForVariableConflicts(secretName, itemId);

    if (conflicts.length > 0) {
      const conflictDetails = conflicts.map(c => `${path.basename(c.filePath)}: ${c.currentValue}`).join('\n');
      const action = await vscode.window.showWarningMessage(
        `Variable "${secretName}" exists with different values in other files:\n\n${conflictDetails}\n\nDo you want to proceed? This might cause configuration conflicts.`,
        { modal: true },
        'Show Conflicts & Choose',
        'Proceed Anyway',
        'Cancel'
      );

      if (action === 'Show Conflicts & Choose') {
        await this.showVariableConflictResolution(secretName, itemId, conflicts);
        return;
      } else if (action !== 'Proceed Anyway') {
        return;
      }
    }

    // If only one .env file exists, use it
    if (this.environmentFiles.length === 1) {
      await this.envService.downloadSecretToLocalFile(this.environmentFiles[0], secretName, itemId);
      await this.refresh();
      return;
    }

    // Multiple .env files exist, let user choose
    const options = this.environmentFiles.map(filePath => ({
      label: path.basename(filePath),
      description: vscode.workspace.asRelativePath(filePath),
      filePath
    }));

    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: `Select .env file to add ${secretName}`
    });

    if (selected) {
      await this.envService.downloadSecretToLocalFile(selected.filePath, secretName, itemId);
      await this.refresh();
    }
  }

  private async createNewEnvFile(secretName: string): Promise<void> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open to create .env file.');
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const envFilePath = path.join(workspaceRoot, '.env');

    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(envFilePath),
        Buffer.from(`${secretName}=\n`, 'utf8')
      );

      // Open the new file
      const document = await vscode.workspace.openTextDocument(envFilePath);
      await vscode.window.showTextDocument(document);

      vscode.window.showInformationMessage(`✅ Created .env file with ${secretName}`);
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create .env file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createNewEnvFileWithSecret(secretName: string, itemId: string): Promise<void> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open to create .env file.');
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const envFilePath = path.join(workspaceRoot, '.env');

    try {
      // Get the actual secret value from 1Password
      const secretValue = await this.envService.getSecretValue(itemId);

      if (secretValue === null) {
        throw new Error(`Failed to retrieve secret value for ${secretName}`);
      }

      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(envFilePath),
        Buffer.from(`${secretName}=${secretValue}\n`, 'utf8')
      );

      // Open the new file
      const document = await vscode.workspace.openTextDocument(envFilePath);
      await vscode.window.showTextDocument(document);

      vscode.window.showInformationMessage(`✅ Created .env file with ${secretName} and its value from 1Password`);
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create .env file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Command to download a 1Password secret to a specific .env file
  async downloadSecretToEnv(item: EnvironmentItem): Promise<void> {
    const secretName = (item as any).secretName;
    const isLocal = (item as any).isLocal;

    if (!secretName) {
      vscode.window.showErrorMessage('Invalid 1Password secret data.');
      return;
    }

    // If already local, just inform user
    if (isLocal) {
      vscode.window.showInformationMessage(`${secretName} already exists in local .env files.`);
      return;
    }

    // Same logic as addRemoteSecretToLocal
    await this.addRemoteSecretToLocal(item);
  }

  // Command to download a 1Password secret to all .env files
  async downloadSecretToAllEnv(item: EnvironmentItem): Promise<void> {
    const secretName = (item as any).secretName;
    const itemId = (item as any).itemId;

    if (!secretName || !itemId) {
      vscode.window.showErrorMessage('Invalid 1Password secret data.');
      return;
    }

    // If no .env files exist, create one
    if (this.environmentFiles.length === 0) {
      await this.createNewEnvFileWithSecret(secretName, itemId);
      return;
    }

    // Add to all existing .env files with real secret value
    let successCount = 0;
    const totalFiles = this.environmentFiles.length;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Adding ${secretName} to all .env files...`,
      cancellable: false
    }, async (progress) => {
      for (const filePath of this.environmentFiles) {
        try {
          await this.envService.downloadSecretToLocalFile(filePath, secretName, itemId);
          successCount++;
          progress.report({
            message: `${successCount}/${totalFiles} files updated`,
            increment: (1 / totalFiles) * 100
          });
        } catch (error) {
          console.error(`Failed to add ${secretName} to ${filePath}:`, error);
        }
      }
    });

    if (successCount === totalFiles) {
      vscode.window.showInformationMessage(`✅ Added ${secretName} with its 1Password value to all ${totalFiles} .env files`);
    } else {
      vscode.window.showWarningMessage(`⚠️ Added ${secretName} to ${successCount}/${totalFiles} .env files. Check the output for errors.`);
    }

    await this.refresh();
  }

  // Command to sync all secrets for a specific file
  async syncAllSecretsForFile(fileUri: vscode.Uri): Promise<void> {
    const filePath = fileUri.fsPath;

    const isConfigured = await this.envService.isConfigured();
    if (!isConfigured) {
      vscode.window.showErrorMessage('1Password not configured.');
      return;
    }

    try {
      const fileSecrets = await this.getFileSecretStatus(filePath);
      const fileName = path.basename(filePath);

      // Count actions needed
      const missingCount = fileSecrets.missing.length;
      const localOnlyCount = fileSecrets.localOnly.length;
      const totalActions = missingCount + localOnlyCount;

      if (totalActions === 0) {
        vscode.window.showInformationMessage(`✅ ${fileName} is already fully synced with 1Password`);
        return;
      }

      // Show confirmation dialog
      const actionSummary = [];
      if (missingCount > 0) actionSummary.push(`${missingCount} secret${missingCount !== 1 ? 's' : ''} to download`);
      if (localOnlyCount > 0) actionSummary.push(`${localOnlyCount} secret${localOnlyCount !== 1 ? 's' : ''} to upload`);

      const confirmation = await vscode.window.showInformationMessage(
        `Sync ${fileName}?\n${actionSummary.join(' and ')}`,
        { modal: true },
        'Sync All',
        'Cancel'
      );

      if (confirmation !== 'Sync All') {
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Syncing ${fileName}...`,
        cancellable: false
      }, async (progress) => {
        let completed = 0;

        // Add missing secrets to file with real values
        for (const remoteSecret of fileSecrets.missing) {
          try {
            await this.envService.downloadSecretToLocalFile(filePath, remoteSecret.name, remoteSecret.itemId);
            completed++;
            progress.report({
              message: `${completed}/${totalActions} secrets synced`,
              increment: (1 / totalActions) * 100
            });
          } catch (error) {
            console.error(`Failed to add ${remoteSecret.name}:`, error);
          }
        }

        // Upload local-only secrets to 1Password
        for (const localVar of fileSecrets.localOnly) {
          try {
            await this.envService.syncSingleVariable(localVar.key, localVar.value, filePath);
            completed++;
            progress.report({
              message: `${completed}/${totalActions} secrets synced`,
              increment: (1 / totalActions) * 100
            });
          } catch (error) {
            console.error(`Failed to upload ${localVar.key}:`, error);
          }
        }
      });

      vscode.window.showInformationMessage(`✅ ${fileName} synced successfully!`);
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to sync ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Command to add a missing secret to a specific file
  async addMissingSecretToFile(item: EnvironmentItem): Promise<void> {
    const secretName = (item as any).envKey;
    const itemId = (item as any).itemId;
    const filePath = (item as any).filePath;

    if (!secretName || !itemId || !filePath) {
      vscode.window.showErrorMessage('Invalid secret data.');
      return;
    }

    try {
      await this.envService.downloadSecretToLocalFile(filePath, secretName, itemId);
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to add ${secretName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Command to upload a local-only secret to 1Password
  async uploadSecretToGitHub(item: EnvironmentItem): Promise<void> {
    const secretName = (item as any).envKey;
    const secretValue = (item as any).envValue;
    const filePath = (item as any).filePath;

    const isConfigured = await this.envService.isConfigured();
    if (!secretName || !secretValue || !filePath || !isConfigured) {
      vscode.window.showErrorMessage('Invalid secret data or 1Password not configured.');
      return;
    }

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Uploading ${secretName} to 1Password...`,
        cancellable: false
      }, async () => {
        await this.envService.syncSingleVariable(secretName, secretValue, filePath);
      });

      vscode.window.showInformationMessage(`✅ ${secretName} uploaded to 1Password`);
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to upload ${secretName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Command to resolve conflicts for synced secrets
  async resolveSecretConflict(item: EnvironmentItem): Promise<void> {
    const secretName = (item as any).envKey;
    const localValue = (item as any).envValue;
    const remoteValue = (item as any).remoteValue;
    const itemId = (item as any).itemId;
    const filePath = (item as any).filePath;

    const isConfigured = await this.envService.isConfigured();
    if (!secretName || !filePath || !isConfigured) {
      vscode.window.showErrorMessage('Invalid secret data or 1Password not configured.');
      return;
    }

    const fileName = path.basename(filePath);

    const choice = await vscode.window.showInformationMessage(
      `"${secretName}" has different values in ${fileName}:\n\nLocal: ${this.maskValue(localValue)}\n1Password: ${this.maskValue(remoteValue || 'unknown')}\n\nWhich value should be used?`,
      { modal: true },
      'Use Local Value (Update 1Password)',
      'Use 1Password Value (Update Local)',
      'Cancel'
    );

    if (!choice || choice === 'Cancel') {
      return;
    }

    try {
      if (choice === 'Use Local Value (Update 1Password)') {
        // Update the existing 1Password item with the local value
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Updating 1Password with local value for ${secretName}...`,
          cancellable: false
        }, async () => {
          await this.envService.updateSecretValue(itemId, localValue);
        });
        vscode.window.showInformationMessage(`✅ Updated 1Password with local value for ${secretName}`);
      } else if (choice === 'Use 1Password Value (Update Local)') {
        // Update local file with 1Password value
        if (itemId) {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Updating ${fileName} with 1Password value for ${secretName}...`,
            cancellable: false
          }, async () => {
            await this.envService.updateLocalEnvVariable(filePath, secretName, remoteValue);
          });
          vscode.window.showInformationMessage(`✅ Updated ${fileName} with 1Password value for ${secretName}`);
        } else {
          vscode.window.showErrorMessage('Cannot update local value - missing item ID');
          return;
        }
      }

      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to resolve conflict for ${secretName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Command to remove a secret from a specific file
  async removeSecretFromFile(item: EnvironmentItem): Promise<void> {
    const secretName = (item as any).envKey;
    const filePath = (item as any).filePath;

    if (!secretName || !filePath) {
      vscode.window.showErrorMessage('Invalid secret data.');
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Remove ${secretName} from ${path.basename(filePath)}?`,
      { modal: true },
      'Remove',
      'Cancel'
    );

    if (confirmation !== 'Remove') {
      return;
    }

    try {
      await this.removeVariableFromFile(filePath, secretName);
      vscode.window.showInformationMessage(`✅ Removed ${secretName} from ${path.basename(filePath)}`);
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to remove ${secretName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async removeVariableFromFile(filePath: string, keyToRemove: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);
      const content = document.getText();
      const lines = content.split('\n');

      // Filter out the line containing the key
      const filteredLines = lines.filter(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) {
          return true; // Keep comments and non-variable lines
        }
        const equalIndex = trimmed.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmed.substring(0, equalIndex).trim();
          return key !== keyToRemove; // Remove lines matching the key
        }
        return true;
      });

      const newContent = filteredLines.join('\n');

      // Write back to file
      const workspaceEdit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(content.length)
      );
      workspaceEdit.replace(document.uri, fullRange, newContent);

      await vscode.workspace.applyEdit(workspaceEdit);
      await document.save();
    } catch (error) {
      console.error('Error removing variable from file:', error);
      throw error;
    }
  }

  public dispose(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }

    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
  }
}

class EnvironmentItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}