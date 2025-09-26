export interface EnvVariable {
  key: string;
  value: string;
  description?: string;
}

export interface RemoteSecret {
  name: string;
  created_at: string;
  updated_at: string;
  itemId: string;
  filePath: string;
  value?: string; // We'll store the value when needed
}

export interface EnvFile {
  filePath: string;
  lastModified: Date;
  content: string;
}

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

export interface EnvFileMetadata {
  repoName: string;
  filePath: string;
  lastModified: string;
  hash: string;
  source: 'local' | 'remote';
}

export interface SyncedEnvFile {
  content: string;
  metadata: EnvFileMetadata;
  itemId?: string;
}