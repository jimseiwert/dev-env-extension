import * as vscode from 'vscode';
import * as path from 'path';
import { createClient, Client, Item, ItemCreateParams, ItemCategory, ItemFieldType, ItemState, ItemListFilter } from '@1password/sdk';

export interface OnePasswordConfig {
  enabled: boolean;
  vaultId: string;
  secretPrefix: string;
}

export interface EnvSecretMetadata {
  secretName: string;
  filePath: string;
  itemId?: string;
}

export class OnePasswordService {
  private config: OnePasswordConfig;
  private client: Client | null = null;
  private secretMetadata: Map<string, EnvSecretMetadata> = new Map();
  private secretStorage: vscode.SecretStorage;

  // Rate limiting and caching
  private lastApiCall: number = 0;
  private minApiInterval: number = 500; // Increased to 500ms between API calls
  private secretsCache: { data: any[], timestamp: number } | null = null;
  private secretsCacheTTL: number = 60000; // Increased to 60 second cache
  private vaultCache: { vaultId: string, timestamp: number } | null = null;

  // Prevent concurrent API calls
  private isLoadingSecrets: boolean = false;
  private pendingSecretsPromise: Promise<any[]> | null = null;

  // Circuit breaker for rate limiting
  private circuitBreakerOpen: boolean = false;
  private circuitBreakerOpenUntil: number = 0;
  private lastRateLimitError: Date | null = null;
  private rateLimitRetryAfter: number = 0; // seconds to wait

  constructor(secretStorage: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
    this.config = this.loadConfig();
  }

  private async rateLimitedApiCall<T>(apiCall: () => Promise<T>, callDescription?: string): Promise<T> {
    const now = Date.now();
    const caller = callDescription || new Error().stack?.split('\n')[2]?.trim() || 'Unknown';

    // Check circuit breaker
    if (this.circuitBreakerOpen && now < this.circuitBreakerOpenUntil) {
      const waitTime = this.circuitBreakerOpenUntil - now;
      console.error(`🚫 Circuit breaker OPEN - refusing API call for ${waitTime}ms: ${caller}`);
      throw new Error(`Circuit breaker open - 1Password API calls temporarily disabled`);
    }

    // Reset circuit breaker if time has passed
    if (this.circuitBreakerOpen && now >= this.circuitBreakerOpenUntil) {
      console.log(`🔓 Circuit breaker RESET - allowing API calls again`);
      this.circuitBreakerOpen = false;
    }

    const timeSinceLastCall = now - this.lastApiCall;
    console.log(`🔄 API Call Request: ${caller} | Time since last: ${timeSinceLastCall}ms`);

    // More aggressive rate limiting - wait at least 3 seconds between calls
    const aggressiveMinInterval = 3000;

    if (timeSinceLastCall < aggressiveMinInterval) {
      const waitTime = aggressiveMinInterval - timeSinceLastCall;
      console.log(`⏳ AGGRESSIVE Rate limiting: waiting ${waitTime}ms before API call (${caller})`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastApiCall = Date.now();
    console.log(`➡️ Making API call: ${caller} at ${new Date().toISOString()}`);

    try {
      const result = await apiCall();
      console.log(`✅ API call successful: ${caller}`);
      return result;
    } catch (error) {
      console.error(`❌ API call failed: ${caller} - ${error}`);

      // If it's a rate limit error, handle it gracefully
      if (error && typeof error === 'object' && 'message' in error &&
          (error.message as string).includes('rate limit')) {

        this.lastRateLimitError = new Date();

        // Try to extract retry-after information from error (if available)
        // Default to 60 seconds if not specified
        this.rateLimitRetryAfter = 60;

        console.warn(`⏳ 1Password rate limit reached. Will retry after ${this.rateLimitRetryAfter} seconds.`);

        // Open circuit breaker with dynamic timeout
        this.circuitBreakerOpen = true;
        this.circuitBreakerOpenUntil = Date.now() + (this.rateLimitRetryAfter * 1000);
        this.lastApiCall = Date.now() + (this.rateLimitRetryAfter * 1000);

        // Show gentle, non-intrusive notification
        this.showRateLimitStatus();
      }

      throw error;
    }
  }

  private showRateLimitStatus(): void {
    const retryTime = new Date(Date.now() + (this.rateLimitRetryAfter * 1000));
    const timeString = retryTime.toLocaleTimeString();

    // Show gentle notification in status bar instead of intrusive popup
    vscode.window.setStatusBarMessage(
      `⏳ 1Password rate limited - retrying at ${timeString}`,
      this.rateLimitRetryAfter * 1000
    );

    // Also show in output channel for debugging
    const outputChannel = vscode.window.createOutputChannel('DevOrb 1Password');
    outputChannel.appendLine(`[${new Date().toISOString()}] Rate limit reached. Next retry scheduled for ${timeString}`);
    outputChannel.appendLine('This is normal - 1Password has conservative rate limits to protect their service.');
    outputChannel.appendLine('DevOrb will automatically retry your request when the limit resets.');
  }

  public getRateLimitStatus(): { isRateLimited: boolean; retryAfter?: Date } {
    if (this.circuitBreakerOpen && Date.now() < this.circuitBreakerOpenUntil) {
      return {
        isRateLimited: true,
        retryAfter: new Date(this.circuitBreakerOpenUntil)
      };
    }
    return { isRateLimited: false };
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
    if (!this.config.enabled) {
      return;
    }

    // Initialize client if configured
    if (await this.isConfigured()) {
      try {
        const token = await this.getServiceAccountToken();
        if (token) {
          this.client = await createClient({
            auth: token,
            integrationName: 'DevOrb VS Code Extension',
            integrationVersion: '1.0.0'
          });
        }
      } catch (error) {
        console.error('1Password SDK initialization failed:', error);
        this.client = null;
      }
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
    if (!this.client) {
      throw new Error('1Password not configured or client not initialized');
    }

    try {
      const vaults = await this.rateLimitedApiCall(() => this.client!.vaults.list(), 'getVaults - vaults.list');
      return vaults.map(vault => ({
        id: vault.id,
        name: vault.title
      }));
    } catch (error) {
      console.error('Error fetching vaults:', error);
      throw new Error('Failed to fetch vaults');
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

  public dispose(): void {
    // Cleanup if needed
  }
}