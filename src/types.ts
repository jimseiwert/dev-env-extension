export interface SyncConfig {
  enabled: boolean;
  gistId?: string;
  syncItems: {
    settings: boolean;
    subagents: boolean;
    hooks: boolean;
    slashCommands: boolean;
    plugins: boolean;
    claudeMd: boolean;
  };
  excludePatterns: string[];
  autoSync: boolean;
  syncInterval: number; // minutes
}

export interface SyncableFile {
  path: string;
  relativePath: string;
  content: string;
  lastModified: number;
  hash: string;
}

export interface GistFile {
  filename: string;
  content: string;
}

export interface GistData {
  files: { [filename: string]: GistFile };
  updated_at: string;
}

export interface SyncStatus {
  lastSync: number;
  issyncing: boolean;
  conflicts: SyncConflict[];
  errors: string[];
}

export interface SyncConflict {
  file: string;
  localHash: string;
  remoteHash: string;
  resolution?: 'local' | 'remote' | 'manual';
}