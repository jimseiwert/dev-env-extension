import * as vscode from 'vscode';
import * as path from 'path';
import { createClient, Client, Item, ItemCreateParams, ItemCategory, ItemFieldType, ItemState, ItemListFilter } from '@1password/sdk';
import { OnePasswordConfig, EnvSecretMetadata } from '../../types';

export class OnePasswordService {
  private config: OnePasswordConfig;
  private client: Client | null = null;
  private secretMetadata: Map<string, EnvSecretMetadata> = new Map();
  private secretStorage: vscode.SecretStorage;

  // Simple rate limiting and caching
  private lastApiCall: number = 0;
  private minApiInterval: number = 100; // Reasonable 100ms between API calls
  private secretsCache: { data: any[], timestamp: number } | null = null;
  private secretsCacheTTL: number = 30000; // 30 second cache
  private vaultCache: { vaultId: string, timestamp: number } | null = null;

  // Prevent concurrent API calls for secrets loading
  private isLoadingSecrets: boolean = false;
  private pendingSecretsPromise: Promise<any[]> | null = null;

  constructor(secretStorage: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
    this.config = this.loadConfig();
  }

  private async rateLimitedApiCall<T>(apiCall: () => Promise<T>, callDescription?: string): Promise<T> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCall;

    // Simple rate limiting - wait minimum interval if needed
    if (timeSinceLastCall < this.minApiInterval) {
      const waitTime = this.minApiInterval - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastApiCall = Date.now();

    try {
      return await apiCall();
    } catch (error) {
      // If it's a rate limit error, wait a bit longer and try once more
      if (error && typeof error === 'object' && 'message' in error &&
          (error.message as string).toLowerCase().includes('rate limit')) {

        console.warn('⏳ 1Password rate limit reached, waiting 5 seconds before retry...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Single retry attempt
        this.lastApiCall = Date.now();
        return await apiCall();
      }

      throw error;
    }
  }


  private loadConfig(): OnePasswordConfig {
    const config = vscode.workspace.getConfiguration('devOrb.env');
    return {
      enabled: config.get('enabled', true),
      vaultId: config.get('onePassword.vaultId', ''),
      secretPrefix: config.get('secretPrefix', '')
    };
  }

  private expandVariables(text: string): string {
    if (!text) return '';

    let expanded = text;

    // Replace VS Code variables
    expanded = expanded.replace(/\$\{workspaceFolderBasename\}/g, () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      return workspaceFolder ? path.basename(workspaceFolder.uri.fsPath) : 'workspace';
    });

    expanded = expanded.replace(/\$\{workspaceFolder\}/g, () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      return workspaceFolder ? workspaceFolder.uri.fsPath : '';
    });

    // Replace environment variables
    expanded = expanded.replace(/\$\{env:([^}]+)\}/g, (match, envVar) => {
      return process.env[envVar] || match;
    });

    // Sanitize for 1Password item names (remove invalid characters)
    expanded = expanded.replace(/[^a-zA-Z0-9_\-\.]/g, '_');

    return expanded;
  }

  private getExpandedPrefix(): string {
    const prefix = this.expandVariables(this.config.secretPrefix);
    return prefix ? `${prefix}_` : '';
  }

  public async initialize(): Promise<void> {
    // Refresh config in case settings have changed
    this.config = this.loadConfig();

    if (!this.config.enabled) {
      return;
    }

    // Initialize client if we have a token (vault can be selected later)
    if (await this.hasServiceAccountToken()) {
      try {
        const token = await this.getServiceAccountToken();
        if (token) {
          this.client = await createClient({
            auth: token,
            integrationName: 'DevOrb VS Code Extension',
            integrationVersion: '1.0.0'
          });
          console.log('✅ 1Password client initialized');
        }
      } catch (error) {
        console.error('❌ 1Password SDK initialization failed:', error);
        this.client = null;
      }
    } else {
      this.client = null;
    }
  }

  public async isConfigured(): Promise<boolean> {
    const token = await this.getServiceAccountToken();
    return !!(token && this.config.vaultId);
  }

  private async getServiceAccountToken(): Promise<string | undefined> {
    return await this.secretStorage.get('devOrb.onePassword.serviceAccountToken');
  }

  public async setServiceAccountToken(token: string): Promise<void> {
    if (!token.startsWith('ops_')) {
      throw new Error('Invalid service account token format. Token should start with "ops_"');
    }
    await this.secretStorage.store('devOrb.onePassword.serviceAccountToken', token);
  }

  public async clearServiceAccountToken(): Promise<void> {
    await this.secretStorage.delete('devOrb.onePassword.serviceAccountToken');
  }

  public async hasServiceAccountToken(): Promise<boolean> {
    const token = await this.getServiceAccountToken();
    return !!token;
  }

  public async ensureDevOrbVault(): Promise<string> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    // Check cached vault first
    if (this.vaultCache && (Date.now() - this.vaultCache.timestamp) < this.secretsCacheTTL) {
      console.log('Using cached vault ID');
      return this.vaultCache.vaultId;
    }

    // If we already have a vault configured, just use it - NO API CALL NEEDED!
    if (this.config.vaultId && this.config.vaultId.trim() !== '') {
      console.log(`Using configured vault ID: ${this.config.vaultId}`);
      // Cache the result
      this.vaultCache = { vaultId: this.config.vaultId, timestamp: Date.now() };
      return this.config.vaultId;
    }

    console.log('No vault configured, searching for DevOrb vault...');
    // Only get vaults list if we need to search for DevOrb vault
    const vaults = await this.rateLimitedApiCall(() => this.client!.vaults.list(), 'vaults.list - searching for DevOrb vault');

    const existingDevOrbVault = vaults.find(v => v.title === 'DevOrb');

    if (existingDevOrbVault) {
      // Update configuration with found vault
      await this.updateVaultIdInConfig(existingDevOrbVault.id);
      // Cache the result
      this.vaultCache = { vaultId: existingDevOrbVault.id, timestamp: Date.now() };
      return existingDevOrbVault.id;
    }

    // Vault creation not supported in current SDK - prompt user to create manually
    throw new Error('DevOrb vault not found. Please create a vault named "DevOrb" in your 1Password account or specify an existing vault ID in settings.');
  }

  private async updateVaultIdInConfig(vaultId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('devOrb.env');
    await config.update('onePassword.vaultId', vaultId, vscode.ConfigurationTarget.Global);
    this.config.vaultId = vaultId;
  }

  public async getVaults(): Promise<Array<{id: string, name: string}>> {
    // Try to initialize client if not already initialized
    if (!this.client) {
      await this.initialize();

      if (!this.client) {
        const hasToken = await this.hasServiceAccountToken();
        if (!hasToken) {
          throw new Error('1Password Service Account Token not configured');
        } else {
          throw new Error('Failed to initialize 1Password client');
        }
      }
    }

    try {
      const vaults = await this.rateLimitedApiCall(() => this.client!.vaults.list(), 'getVaults - vaults.list');

      return vaults.map(vault => ({
        id: vault.id,
        name: vault.title
      }));
    } catch (error) {
      console.error('❌ Error fetching vaults:', error);
      throw new Error(`Failed to fetch vaults: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getEnvironmentSecrets(): Promise<Item[]> {
    if (!this.client) {
      return [];
    }

    // Check cache first
    if (this.secretsCache && (Date.now() - this.secretsCache.timestamp) < this.secretsCacheTTL) {
      console.log('Using cached environment secrets');
      return this.secretsCache.data;
    }

    // If we're already loading secrets, wait for the existing call to complete
    if (this.isLoadingSecrets && this.pendingSecretsPromise) {
      console.log('Already loading secrets, waiting for completion...');
      return this.pendingSecretsPromise;
    }

    // Mark as loading and create the promise
    this.isLoadingSecrets = true;
    this.pendingSecretsPromise = this.loadSecretsInternal();

    try {
      const result = await this.pendingSecretsPromise;
      return result;
    } finally {
      this.isLoadingSecrets = false;
      this.pendingSecretsPromise = null;
    }
  }

  private async loadSecretsInternal(): Promise<Item[]> {
    try {
      console.log('Starting to load 1Password secrets...');
      const vaultId = await this.ensureDevOrbVault();

      // Use items.list() with active filter to get only active items from the API
      const activeFilter: ItemListFilter = {
        type: "ByState",
        content: {
          active: true,
          archived: false
        }
      };

      const items = await this.rateLimitedApiCall(
        () => this.client!.items.list(vaultId, activeFilter),
        'items.list with active filter'
      );
      console.log(`Found ${items.length} active items in vault`);

      // Filter items that have our devorb tag (already filtered for active by API)
      const envItems = items.filter(item => item.tags.includes('devorb'));
      console.log(`Found ${envItems.length} active DevOrb environment items`);

      if (envItems.length === 0) {
        console.log('No DevOrb items found, caching empty result');
        this.secretsCache = { data: [], timestamp: Date.now() };
        return [];
      }

      // Get current repository info for filtering
      const currentRepoInfo = await this.gatherSecretMetadata('');
      const currentRepoName = currentRepoInfo.repoName;
      console.log(`Current repository: ${currentRepoName || 'none'}`);

      // Build secret reference URIs for all items
      console.log(`Building secret references for ${envItems.length} items...`);

      const secretReferences: string[] = [];
      const itemsMap = new Map<string, any>();

      for (const item of envItems) {
        // Secret reference format: op://vault-id/item-id/field-id
        const secretValueRef = `op://${vaultId}/${item.id}/secret-value-field`;
        const repoRef = `op://${vaultId}/${item.id}/repo-field`;
        const filePathRef = `op://${vaultId}/${item.id}/file-path-field`;

        secretReferences.push(secretValueRef, repoRef, filePathRef);
        itemsMap.set(secretValueRef, { item, type: 'secretValue' });
        itemsMap.set(repoRef, { item, type: 'repository' });
        itemsMap.set(filePathRef, { item, type: 'filePath' });
      }

      if (secretReferences.length === 0) {
        console.log('No secret references to resolve');
        this.secretsCache = { data: [], timestamp: Date.now() };
        return [];
      }

      console.log(`Resolving ${secretReferences.length} secrets in ONE API call using secrets.resolveAll()...`);

      // Use secrets.resolveAll() to get ALL secrets in one call
      const resolveResult = await this.rateLimitedApiCall(
        () => (this.client as any).secrets.resolveAll(secretReferences),
        `secrets.resolveAll for ${envItems.length} items`
      );

      console.log('Secrets resolved successfully');

      // Process results and build full items with repository filtering
      const fullItems: Item[] = [];
      const itemDataMap = new Map<string, any>(); // itemId -> { secretValue, repository, filePath }

      // Process all resolved secrets
      for (const [secretRef, response] of Object.entries((resolveResult as any).individualResponses)) {
        const mapEntry = itemsMap.get(secretRef);
        if (!mapEntry) continue;

        const { item, type } = mapEntry;

        if ((response as any).success) {
          const resolvedData = (response as any).data;

          if (!itemDataMap.has(item.id)) {
            itemDataMap.set(item.id, { item });
          }

          const itemData = itemDataMap.get(item.id);
          itemData[type] = resolvedData.secret;
        } else {
          console.warn(`Failed to resolve ${type} for ${item.title}:`, (response as any).error);
        }
      }

      // Build full items with repository filtering
      for (const [itemId, itemData] of itemDataMap.entries()) {
        const { item, repository, filePath, secretValue } = itemData;

        // Repository filtering
        if (!repository || !currentRepoName || repository === currentRepoName) {
          // Create a full Item structure with resolved data
          const fullItem: Item = {
            ...item,
            fields: [
              { title: 'Secret Value', fieldType: ItemFieldType.Concealed, value: secretValue || '' },
              { title: 'Secret Name', fieldType: ItemFieldType.Text, value: item.title.replace(this.getExpandedPrefix(), '').replace(/^_/, '') },
              { title: 'File Path', fieldType: ItemFieldType.Text, value: filePath || '' },
              { title: 'Repository', fieldType: ItemFieldType.Text, value: repository || '' }
            ]
          };

          fullItems.push(fullItem);
        } else {
          console.log(`Skipping item for different repo: ${repository} (current: ${currentRepoName})`);
        }
      }

      console.log(`Successfully processed ${fullItems.length} out of ${envItems.length} items using secrets.resolveAll()`);

      // Cache the results
      this.secretsCache = { data: fullItems, timestamp: Date.now() };
      return fullItems;

    } catch (error) {
      console.error('Error fetching 1Password items:', error);
      // Return empty array but still cache to prevent retries
      this.secretsCache = { data: [], timestamp: Date.now() };
      return [];
    }
  }

  public async getSecretValue(itemId: string): Promise<string | null> {
    if (!this.client) {
      return null;
    }

    try {
      const vaultId = await this.ensureDevOrbVault();
      const item = await this.rateLimitedApiCall(() => this.client!.items.get(vaultId, itemId), `getSecretValue for ${itemId}`);

      // Look for the concealed field that contains the secret value
      const secretField = item.fields.find(f =>
        f.fieldType === ItemFieldType.Concealed && f.title === 'Secret Value'
      );
      return secretField?.value || null;
    } catch (error) {
      console.error('Error fetching secret value:', error);
      return null;
    }
  }

  // Cache invalidation methods
  public invalidateSecretsCache(): void {
    console.log('Invalidating secrets cache');
    this.secretsCache = null;
  }

  public invalidateVaultCache(): void {
    console.log('Invalidating vault cache');
    this.vaultCache = null;
  }

  public async createOrUpdateSecret(secretName: string, value: string, filePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('1Password not configured');
    }

    // Ensure vault exists or create it
    const vaultId = await this.ensureDevOrbVault();

    const prefix = this.getExpandedPrefix();
    const itemTitle = `${prefix}${secretName}`;

    // Check if exact item already exists (same name and value)
    const existingItems = await this.rateLimitedApiCall(() => this.client!.items.list(vaultId));

    // Look for existing item with the same name, value, and file path
    let matchingItem = null;
    for (const item of existingItems.filter(item => item.tags.includes('devorb'))) {
      if (item.title === itemTitle) {
        try {
          const fullItem = await this.rateLimitedApiCall(() => this.client!.items.get(vaultId, item.id));
          const secretField = fullItem.fields.find(f => f.fieldType === ItemFieldType.Concealed && f.title === 'Secret Value');
          const secretNameField = fullItem.fields.find(f => f.title === 'Secret Name');
          const filePathField = fullItem.fields.find(f => f.title === 'File Path');

          // Check if this is the same variable name, value, and file path
          if (secretNameField?.value === secretName &&
              secretField?.value === value &&
              filePathField?.value === filePath) {
            matchingItem = fullItem;
            break;
          }
        } catch (error) {
          console.error(`Error checking item ${item.id}:`, error);
        }
      }
    }

    if (matchingItem) {
      // Secret with same name, value, and file already exists - nothing to do
      return;
    } else {
      // Create new item with clean name - 1Password allows duplicates
      await this.createSecret(itemTitle, secretName, value, filePath);
      // Invalidate cache since we created something new
      this.invalidateSecretsCache();
    }
  }

  private async createSecret(title: string, secretName: string, value: string, filePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    const vaultId = await this.ensureDevOrbVault();
    const metadata = await this.gatherSecretMetadata(filePath);

    const itemData: ItemCreateParams = {
      category: ItemCategory.Password,
      vaultId: vaultId,
      title: title,
      tags: this.generateSecretTags(filePath, metadata),
      fields: [
        {
          id: 'secret-name-field',
          title: 'Secret Name',
          fieldType: ItemFieldType.Text,
          value: secretName
        },
        {
          id: 'secret-value-field',
          title: 'Secret Value',
          fieldType: ItemFieldType.Concealed,
          value: value
        },
        {
          id: 'file-path-field',
          title: 'File Path',
          fieldType: ItemFieldType.Text,
          value: filePath
        },
        {
          id: 'workspace-field',
          title: 'Workspace',
          fieldType: ItemFieldType.Text,
          value: metadata.workspaceName
        },
        ...(metadata.repoName ? [{
          id: 'repo-field',
          title: 'Repository',
          fieldType: ItemFieldType.Text,
          value: metadata.repoName
        }] : []),
        ...(metadata.repoUrl ? [{
          id: 'repo-url-field',
          title: 'Repository URL',
          fieldType: ItemFieldType.Url,
          value: metadata.repoUrl
        }] : [])
      ],
      notes: `DevOrb Environment Variable\n\nCreated: ${new Date().toISOString()}\nOriginal File: ${filePath}\nWorkspace: ${metadata.workspaceName}${metadata.repoName ? `\nRepository: ${metadata.repoName}` : ''}`
    };

    await this.rateLimitedApiCall(() => this.client!.items.create(itemData));
  }


  private async gatherSecretMetadata(filePath: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceName = workspaceFolder ? path.basename(workspaceFolder.uri.fsPath) : 'Unknown';

    let repoName = '';
    let repoUrl = '';

    try {
      // Try to get git repository information
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (gitExtension) {
        const git = gitExtension.getAPI(1);
        if (git && git.repositories.length > 0) {
          const repo = git.repositories[0];
          const remotes = repo.state.remotes;

          for (const remote of remotes) {
            if (remote.name === 'origin' && remote.fetchUrl) {
              repoUrl = remote.fetchUrl;

              // Extract repo name from URL
              const match = remote.fetchUrl.match(/\/([^\/]+?)(?:\.git)?$/);
              if (match) {
                repoName = match[1];
              }
              break;
            }
          }
        }
      }
    } catch (error) {
      console.debug('Could not get git repository info:', error);
    }

    return {
      workspaceName,
      repoName,
      repoUrl
    };
  }

  private generateSecretTags(filePath: string, metadata: any): string[] {
    const tags = ['devorb'];

    // Add file-specific tags
    const fileName = path.basename(filePath);
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9\-\.]/g, '_');
    tags.push(`file:${sanitizedFileName}`);

    // Add workspace tag
    const sanitizedWorkspace = metadata.workspaceName.replace(/[^a-zA-Z0-9\-\.]/g, '_');
    tags.push(`workspace:${sanitizedWorkspace}`);

    // Add repository tag if available
    if (metadata.repoName) {
      const sanitizedRepo = metadata.repoName.replace(/[^a-zA-Z0-9\-\.]/g, '_');
      tags.push(`repo:${sanitizedRepo}`);
    }

    return tags;
  }

  public async updateSecretValue(itemId: string, newValue: string): Promise<void> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    try {
      const vaultId = await this.ensureDevOrbVault();
      // Get the current item
      const currentItem = await this.rateLimitedApiCall(() => this.client!.items.get(vaultId, itemId));

      // Update the secret value field
      const updatedFields = currentItem.fields.map(field => {
        if (field.fieldType === ItemFieldType.Concealed && field.title === 'Secret Value') {
          return { ...field, value: newValue };
        }
        return field;
      });

      const updatedItem = {
        ...currentItem,
        fields: updatedFields
      };

      await this.rateLimitedApiCall(() => this.client!.items.put(updatedItem));
      // Invalidate cache since we updated something
      this.invalidateSecretsCache();
    } catch (error) {
      console.error('Error updating secret value:', error);
      throw new Error('Failed to update secret value');
    }
  }

  private async updateSecret(itemId: string, value: string, filePath: string): Promise<void> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    try {
      const vaultId = await this.ensureDevOrbVault();
      // Get the current item
      const currentItem = await this.rateLimitedApiCall(() => this.client!.items.get(vaultId, itemId), `updateSecret - get ${itemId}`);

      // Update the secret value field
      const updatedFields = currentItem.fields.map(field => {
        if (field.fieldType === ItemFieldType.Concealed && field.title === 'Secret Value') {
          return { ...field, value: value };
        }
        // Also update the file path if it's different
        if (field.fieldType === ItemFieldType.Text && field.title === 'File Path') {
          return { ...field, value: filePath };
        }
        return field;
      });

      const updatedItem: Item = {
        ...currentItem,
        fields: updatedFields
      };

      await this.rateLimitedApiCall(() => this.client!.items.put(updatedItem), `updateSecret - put ${itemId}`);
    } catch (error) {
      console.error('Error updating secret:', error);
      throw new Error('Failed to update secret');
    }
  }

  public async deleteSecret(secretName: string): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const vaultId = await this.ensureDevOrbVault();
      // Find the item to delete by searching for it
      const items = await this.rateLimitedApiCall(() => this.client!.items.list(vaultId), `deleteSecret - list items for ${secretName}`);
      const prefix = this.getExpandedPrefix();
      const itemTitle = `${prefix}${secretName}`;
      const itemToDelete = items.find(item =>
        item.title === itemTitle && item.tags.includes('devorb')
      );

      if (itemToDelete) {
        await this.rateLimitedApiCall(() => this.client!.items.delete(vaultId, itemToDelete.id), `deleteSecret - delete ${secretName}`);
      }
    } catch (error) {
      console.error('Error deleting secret:', error);
    }
  }

  public getSignupUrl(): string {
    return 'https://start.1password.com/sign-up';
  }

  // File-based sync methods
  public async createEnvFile(fileName: string, content: string, metadata: import('../../types').EnvFileMetadata): Promise<string> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    try {
      const vaultId = await this.ensureDevOrbVault();

      const itemParams: ItemCreateParams = {
        vaultId,
        category: ItemCategory.Document,
        title: `DevOrb Env: ${metadata.repoName}/${fileName}`,
        fields: [
          {
            id: 'repository',
            fieldType: ItemFieldType.Text,
            title: 'Repository',
            value: metadata.repoName
          },
          {
            id: 'file_path',
            fieldType: ItemFieldType.Text,
            title: 'File Path',
            value: metadata.filePath
          },
          {
            id: 'last_modified',
            fieldType: ItemFieldType.Text,
            title: 'Last Modified',
            value: metadata.lastModified
          },
          {
            id: 'hash',
            fieldType: ItemFieldType.Text,
            title: 'Hash',
            value: metadata.hash
          },
          {
            id: 'file_content',
            fieldType: ItemFieldType.Concealed,
            title: 'File Content',
            value: content
          }
        ],
        tags: [`devorb`, `repo:${metadata.repoName}`, `env-file`, `source:${metadata.source}`]
      };

      const item = await this.rateLimitedApiCall(() => this.client!.items.create(itemParams), `createEnvFile - ${fileName}`);
      console.log(`✅ Created env file in 1Password: ${fileName}`);

      // Invalidate cache
      this.invalidateSecretsCache();

      return item.id;
    } catch (error) {
      console.error('Error creating env file in 1Password:', error);
      throw new Error('Failed to create env file');
    }
  }

  public async updateEnvFile(itemId: string, content: string, metadata: import('../../types').EnvFileMetadata): Promise<void> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    try {
      const vaultId = await this.ensureDevOrbVault();

      // Get the current item
      const currentItem = await this.rateLimitedApiCall(() => this.client!.items.get(vaultId, itemId));

      // Update the fields
      const updatedFields = currentItem.fields.map(field => {
        if (field.title === 'File Content') {
          return { ...field, value: content };
        }
        if (field.title === 'Last Modified') {
          return { ...field, value: metadata.lastModified };
        }
        if (field.title === 'Hash') {
          return { ...field, value: metadata.hash };
        }
        return field;
      });

      const updatedItem = {
        ...currentItem,
        fields: updatedFields,
        tags: [...(currentItem.tags || []).filter(tag => !tag.startsWith('source:')), `source:${metadata.source}`]
      };

      await this.rateLimitedApiCall(() => this.client!.items.put(updatedItem));
      console.log(`✅ Updated env file in 1Password: ${metadata.filePath}`);

      // Invalidate cache
      this.invalidateSecretsCache();
    } catch (error) {
      console.error('Error updating env file:', error);
      throw new Error('Failed to update env file');
    }
  }

  public async findEnvFileByPath(repoName: string, filePath: string): Promise<{ id: string; title: string } | null> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    try {
      const vaultId = await this.ensureDevOrbVault();
      const items = await this.rateLimitedApiCall(() => this.client!.items.list(vaultId), `findEnvFileByPath - ${filePath}`);

      const envFileItems = items.filter(item =>
        item.tags.includes('env-file') &&
        item.tags.includes(`repo:${repoName}`) &&
        item.category === ItemCategory.Document
      );

      for (const item of envFileItems) {
        // Get full item details to check the file path field
        const fullItem = await this.rateLimitedApiCall(() => this.client!.items.get(vaultId, item.id));
        const filePathField = fullItem.fields.find(field => field.title === 'File Path');

        if (filePathField?.value === filePath) {
          return {
            id: item.id,
            title: item.title
          };
        }
      }

      return null;
    } catch (error) {
      console.error('Error finding env file by path:', error);
      return null;
    }
  }

  public async getEnvFilesForRepo(repoName: string): Promise<import('../../types').SyncedEnvFile[]> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    try {
      const vaultId = await this.ensureDevOrbVault();
      const items = await this.rateLimitedApiCall(() => this.client!.items.list(vaultId), `getEnvFilesForRepo - ${repoName}`);

      const envFileItems = items.filter(item =>
        item.tags.includes('env-file') &&
        item.tags.includes(`repo:${repoName}`) &&
        item.category === ItemCategory.Document
      );

      const syncedFiles: import('../../types').SyncedEnvFile[] = [];

      for (const item of envFileItems) {
        try {
          // Get full item details
          const fullItem = await this.rateLimitedApiCall(() => this.client!.items.get(vaultId, item.id));

          const getFieldValue = (title: string) =>
            fullItem.fields.find(field => field.title === title)?.value || '';

          const content = getFieldValue('File Content');
          const filePath = getFieldValue('File Path');
          const lastModified = getFieldValue('Last Modified');
          const hash = getFieldValue('Hash');

          if (content && filePath) {
            syncedFiles.push({
              content,
              metadata: {
                repoName,
                filePath,
                lastModified: lastModified || new Date().toISOString(),
                hash: hash || '',
                source: 'remote'
              },
              itemId: item.id
            });
          }
        } catch (error) {
          console.warn(`Could not load env file item ${item.id}:`, error);
        }
      }

      return syncedFiles;
    } catch (error) {
      console.error('Error getting env files for repo:', error);
      return [];
    }
  }

  public async deleteEnvFile(itemId: string): Promise<void> {
    if (!this.client) {
      throw new Error('1Password client not initialized');
    }

    try {
      const vaultId = await this.ensureDevOrbVault();
      await this.rateLimitedApiCall(() => this.client!.items.delete(vaultId, itemId));
      console.log(`✅ Deleted env file from 1Password: ${itemId}`);

      // Invalidate cache
      this.invalidateSecretsCache();
    } catch (error) {
      console.error('Error deleting env file:', error);
      throw new Error('Failed to delete env file');
    }
  }

  public dispose(): void {
    // Cleanup if needed
  }
}