import * as vscode from 'vscode';
import * as path from 'path';
import { OnePasswordService } from './onePasswordService';
import { Item } from '@1password/sdk';

export interface EnvVariable {
  key: string;
  value: string;
}

export interface RemoteSecret {
  name: string;
  created_at: string;
  updated_at: string;
  itemId: string;
  filePath: string;
  value?: string; // We'll store the value when needed
}

export class EnvironmentService {
  private onePasswordService: OnePasswordService;

  constructor(secretStorage: vscode.SecretStorage) {
    this.onePasswordService = new OnePasswordService(secretStorage);
  }

  public async initialize(): Promise<void> {
    await this.onePasswordService.initialize();
  }

  public async isConfigured(): Promise<boolean> {
    return this.onePasswordService.isConfigured();
  }

  public async syncEnvFile(filePath: string): Promise<void> {
    if (!this.onePasswordService.isConfigured()) {
      throw new Error('1Password not configured');
    }

    const envVars = await this.parseEnvFile(filePath);

    for (const variable of envVars) {
      await this.onePasswordService.createOrUpdateSecret(variable.key, variable.value, filePath);
    }
  }

  public async syncSingleVariable(key: string, value: string, filePath: string): Promise<void> {
    if (!this.onePasswordService.isConfigured()) {
      throw new Error('1Password not configured');
    }

    await this.onePasswordService.createOrUpdateSecret(key, value, filePath);
  }

  private async parseEnvFile(filePath: string): Promise<EnvVariable[]> {
    const document = await vscode.workspace.openTextDocument(filePath);
    const content = document.getText();
    const lines = content.split('\n');
    const variables: EnvVariable[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const equalIndex = trimmed.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmed.substring(0, equalIndex).trim();
          const value = trimmed.substring(equalIndex + 1).trim();
          variables.push({ key, value });
        }
      }
    }

    return variables;
  }

  public async getRemoteSecrets(): Promise<RemoteSecret[]> {
    if (!this.onePasswordService.isConfigured()) {
      return [];
    }

    try {
      const items = await this.onePasswordService.getEnvironmentSecrets();
      return items.map((item: Item) => ({
        name: this.extractSecretNameFromTitle(item.title),
        created_at: item.createdAt.toISOString(),
        updated_at: item.updatedAt.toISOString(),
        itemId: item.id,
        filePath: this.extractFilePathFromFields(item.fields)
      }));
    } catch (error) {
      console.error('Error fetching remote secrets:', error);
      return [];
    }
  }

  public async getSecretValue(itemId: string): Promise<string | null> {
    return await this.onePasswordService.getSecretValue(itemId);
  }

  public async deleteSecret(secretName: string): Promise<void> {
    await this.onePasswordService.deleteSecret(secretName);
  }

  private extractSecretNameFromTitle(title: string): string {
    // Remove the expanded prefix to get the original secret name
    const config = vscode.workspace.getConfiguration('devOrb.env');
    let prefix = config.get('secretPrefix', '');

    if (prefix) {
      // Expand the prefix the same way OnePasswordService does
      prefix = this.expandVariables(prefix) + '_';
      if (title.startsWith(prefix)) {
        title = title.substring(prefix.length);
      }
    }

    // Since we now use clean names in 1Password titles, no need to remove suffixes
    // The title should be the exact variable name (e.g., "DATABASE_URL", "API_KEY", etc.)
    return title;
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

  private extractFilePathFromFields(fields: Array<{title: string, value: string}>): string {
    // Try current single file format
    const filePathField = fields.find(f => f.title === 'File Path');
    if (filePathField?.value) {
      return filePathField.value;
    }

    // Fallback to old array format (take first element)
    const filePathsField = fields.find(f => f.title === 'File Paths');
    if (filePathsField?.value) {
      try {
        const paths = JSON.parse(filePathsField.value);
        return Array.isArray(paths) && paths.length > 0 ? paths[0] : '';
      } catch {
        return filePathsField.value; // If JSON parsing fails, treat as single value
      }
    }

    return '';
  }


  public async updateLocalEnvVariable(filePath: string, key: string, newValue: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);
      const content = document.getText();
      const lines = content.split('\n');

      // Find the line with this variable
      let updatedContent = '';
      let found = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${key}=`) && !trimmed.startsWith('#')) {
          // Replace this line with the new value
          updatedContent += `${key}=${newValue}\n`;
          found = true;
        } else {
          updatedContent += line + '\n';
        }
      }

      if (!found) {
        throw new Error(`Variable ${key} not found in ${filePath}`);
      }

      // Remove trailing newline if the original didn't have one
      if (!content.endsWith('\n')) {
        updatedContent = updatedContent.slice(0, -1);
      }

      // Write back to file
      const workspaceEdit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(content.length)
      );
      workspaceEdit.replace(document.uri, fullRange, updatedContent);

      await vscode.workspace.applyEdit(workspaceEdit);
      await document.save();

      vscode.window.showInformationMessage(`✅ Updated ${key} in ${path.basename(filePath)}`);
    } catch (error) {
      console.error('Error updating local env variable:', error);
      vscode.window.showErrorMessage(`Failed to update ${key}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  public async createLocalEnvVariable(filePath: string, key: string, placeholder: string = ''): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);
      const content = document.getText();

      // Check if variable already exists
      const lines = content.split('\n');
      const existingVar = lines.find(line => {
        const trimmed = line.trim();
        return trimmed.startsWith(`${key}=`) && !trimmed.startsWith('#');
      });

      if (existingVar) {
        vscode.window.showInformationMessage(`Variable ${key} already exists in ${filePath}`);
        return;
      }

      // Use meaningful placeholder if none provided
      const valueToUse = placeholder || '<FILL_IN_VALUE>';

      // Add the new variable at the end
      const newLine = `${key}=${valueToUse}`;
      const newContent = content.endsWith('\n') ? content + newLine + '\n' : content + '\n' + newLine + '\n';

      // Write back to file
      const workspaceEdit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(content.length)
      );
      workspaceEdit.replace(document.uri, fullRange, newContent);

      await vscode.workspace.applyEdit(workspaceEdit);
      await document.save();

      vscode.window.showInformationMessage(`✅ Added ${key} to ${path.basename(filePath)} - please fill in the value`);
    } catch (error) {
      console.error('Error creating local env variable:', error);
      vscode.window.showErrorMessage(`Failed to add ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public getSignupUrl(): string {
    return this.onePasswordService.getSignupUrl();
  }

  public async setServiceAccountToken(token: string): Promise<void> {
    await this.onePasswordService.setServiceAccountToken(token);
  }

  public async clearServiceAccountToken(): Promise<void> {
    await this.onePasswordService.clearServiceAccountToken();
  }

  public async hasServiceAccountToken(): Promise<boolean> {
    return await this.onePasswordService.hasServiceAccountToken();
  }

  public async ensureDevOrbVault(): Promise<string> {
    return await this.onePasswordService.ensureDevOrbVault();
  }

  public async getVaults(): Promise<Array<{id: string, name: string}>> {
    return await this.onePasswordService.getVaults();
  }

  public async updateSecretValue(itemId: string, newValue: string): Promise<void> {
    await this.onePasswordService.updateSecretValue(itemId, newValue);
  }

  public async downloadSecretToLocalFile(filePath: string, secretName: string, itemId: string): Promise<void> {
    try {
      // Get the actual secret value from 1Password
      const secretValue = await this.getSecretValue(itemId);

      if (secretValue === null) {
        throw new Error(`Failed to retrieve secret value for ${secretName}`);
      }

      // Create the local environment variable with the real value
      await this.createLocalEnvVariable(filePath, secretName, secretValue);
    } catch (error) {
      console.error('Error downloading secret to local file:', error);
      throw error;
    }
  }

  public dispose(): void {
    this.onePasswordService.dispose();
  }
}