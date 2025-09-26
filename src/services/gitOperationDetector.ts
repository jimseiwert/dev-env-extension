import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface GitState {
  currentBranch: string;
  lastCommitHash: string;
  isInGitOperation: boolean;
  lastGitOperationType?: 'checkout' | 'merge' | 'rebase' | 'pull' | 'reset';
}

export class GitOperationDetector {
  private gitStates: Map<string, GitState> = new Map();
  private gitOperationTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private gitStateWatcher?: NodeJS.Timeout;
  private readonly GIT_OPERATION_TIMEOUT = 5000; // 5 seconds
  private readonly GIT_STATE_CHECK_INTERVAL = 2000; // Check every 2 seconds

  private onBranchChangeCallback?: (workspacePath: string) => Promise<void>;

  constructor() {
    this.initializeGitStates();
    this.startGitStateWatcher();
  }

  private async initializeGitStates(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
      const gitDir = path.join(folder.uri.fsPath, '.git');
      if (fs.existsSync(gitDir)) {
        const state = await this.getCurrentGitState(folder.uri.fsPath);
        this.gitStates.set(folder.uri.fsPath, state);
      }
    }
  }

  private async getCurrentGitState(workspacePath: string): Promise<GitState> {
    const gitDir = path.join(workspacePath, '.git');

    let currentBranch = 'main';
    let lastCommitHash = '';

    try {
      // Get current branch
      const headFile = path.join(gitDir, 'HEAD');
      if (fs.existsSync(headFile)) {
        const headContent = fs.readFileSync(headFile, 'utf8').trim();
        if (headContent.startsWith('ref: refs/heads/')) {
          currentBranch = headContent.replace('ref: refs/heads/', '');
        } else {
          // Detached HEAD state
          currentBranch = headContent.substring(0, 8);
        }
      }

      // Get last commit hash
      const commitFile = path.join(gitDir, 'refs', 'heads', currentBranch);
      if (fs.existsSync(commitFile)) {
        lastCommitHash = fs.readFileSync(commitFile, 'utf8').trim();
      }
    } catch (error) {
      console.warn('Could not read git state:', error);
    }

    return {
      currentBranch,
      lastCommitHash,
      isInGitOperation: false
    };
  }

  public async detectGitOperation(workspacePath: string): Promise<'user' | 'git' | 'unknown'> {
    const gitDir = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitDir)) {
      console.log('🔍 No .git directory found, assuming user operation');
      return 'user'; // If no git repo, it's definitely a user operation
    }

    // Check if we're currently in a git operation first
    if (this.isCurrentlyInGitOperation(workspacePath)) {
      console.log('🔍 Currently in git operation, marking as git');
      return 'git';
    }

    // Check if we recently detected a git operation
    const state = this.gitStates.get(workspacePath);
    if (state?.isInGitOperation) {
      console.log('🔍 Recent git operation detected, marking as git');
      return 'git';
    }

    const currentState = await this.getCurrentGitState(workspacePath);
    const previousState = this.gitStates.get(workspacePath);

    if (!previousState) {
      console.log('🔍 No previous state found, initializing and assuming user operation');
      this.gitStates.set(workspacePath, currentState);
      return 'user'; // If no previous state and no active git operation, likely user action
    }

    // Check if branch changed (checkout operation)
    if (previousState.currentBranch !== currentState.currentBranch) {
      console.log(`🔀 Branch change detected: ${previousState.currentBranch} → ${currentState.currentBranch}`);
      this.markGitOperation(workspacePath, 'checkout');
      this.gitStates.set(workspacePath, currentState);
      return 'git';
    }

    // Check if commit hash changed (pull, merge, rebase, etc.)
    if (previousState.lastCommitHash !== currentState.lastCommitHash) {
      console.log(`📝 Commit change detected: ${previousState.lastCommitHash?.substring(0, 8)} → ${currentState.lastCommitHash?.substring(0, 8)}`);
      this.markGitOperation(workspacePath, 'pull');
      this.gitStates.set(workspacePath, currentState);
      return 'git';
    }

    // Update state for next comparison
    this.gitStates.set(workspacePath, currentState);
    console.log('🔍 No git changes detected, marking as user operation');
    return 'user';
  }

  private isCurrentlyInGitOperation(workspacePath: string): boolean {
    const gitDir = path.join(workspacePath, '.git');

    // Check for common git operation files
    const gitOperationFiles = [
      'MERGE_HEAD',      // merge in progress
      'CHERRY_PICK_HEAD', // cherry-pick in progress
      'REVERT_HEAD',     // revert in progress
      'REBASE_HEAD',     // rebase in progress
      'rebase-merge',    // interactive rebase
      'rebase-apply',    // am/rebase in progress
      'BISECT_LOG'       // bisect in progress
    ];

    for (const file of gitOperationFiles) {
      if (fs.existsSync(path.join(gitDir, file))) {
        return true;
      }
    }

    return false;
  }

  private markGitOperation(workspacePath: string, operationType: 'checkout' | 'merge' | 'rebase' | 'pull' | 'reset'): void {
    const currentState = this.gitStates.get(workspacePath);
    if (currentState) {
      currentState.isInGitOperation = true;
      currentState.lastGitOperationType = operationType;
    }

    // Clear any existing timeout
    const existingTimeout = this.gitOperationTimeouts.get(workspacePath);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set a timeout to clear the git operation flag
    const timeout = setTimeout(() => {
      const state = this.gitStates.get(workspacePath);
      if (state) {
        state.isInGitOperation = false;
        delete state.lastGitOperationType;
      }
      this.gitOperationTimeouts.delete(workspacePath);
    }, this.GIT_OPERATION_TIMEOUT);

    this.gitOperationTimeouts.set(workspacePath, timeout);
  }

  public isInGitOperation(workspacePath: string): boolean {
    const state = this.gitStates.get(workspacePath);
    return state?.isInGitOperation ?? false;
  }

  public getLastGitOperation(workspacePath: string): string | undefined {
    const state = this.gitStates.get(workspacePath);
    return state?.lastGitOperationType;
  }

  public async shouldResyncAfterBranchChange(workspacePath: string): Promise<boolean> {
    const state = this.gitStates.get(workspacePath);
    return state?.lastGitOperationType === 'checkout' && state.isInGitOperation;
  }

  public onBranchChange(callback: (workspacePath: string) => Promise<void>): void {
    this.onBranchChangeCallback = callback;
  }

  private startGitStateWatcher(): void {
    this.gitStateWatcher = setInterval(async () => {
      await this.checkForGitChanges();
    }, this.GIT_STATE_CHECK_INTERVAL);
  }

  private async checkForGitChanges(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
      const gitDir = path.join(folder.uri.fsPath, '.git');
      if (fs.existsSync(gitDir)) {
        try {
          const currentState = await this.getCurrentGitState(folder.uri.fsPath);
          const previousState = this.gitStates.get(folder.uri.fsPath);

          if (previousState && previousState.currentBranch !== currentState.currentBranch) {
            console.log(`🔀 Branch change detected in ${folder.name}: ${previousState.currentBranch} → ${currentState.currentBranch}`);

            this.markGitOperation(folder.uri.fsPath, 'checkout');
            this.gitStates.set(folder.uri.fsPath, currentState);

            // Call the branch change callback if set
            if (this.onBranchChangeCallback) {
              try {
                await this.onBranchChangeCallback(folder.uri.fsPath);
              } catch (error) {
                console.error('Branch change callback failed:', error);
              }
            }
          } else if (previousState && previousState.lastCommitHash !== currentState.lastCommitHash) {
            // Commit change detected - could be pull, merge, etc.
            this.markGitOperation(folder.uri.fsPath, 'pull');
            this.gitStates.set(folder.uri.fsPath, currentState);
          } else if (!previousState) {
            // First time seeing this workspace
            this.gitStates.set(folder.uri.fsPath, currentState);
          }
        } catch (error) {
          console.debug('Error checking git state:', error);
        }
      }
    }
  }

  public dispose(): void {
    // Clear the git state watcher
    if (this.gitStateWatcher) {
      clearInterval(this.gitStateWatcher);
      this.gitStateWatcher = undefined;
    }

    // Clear all timeouts
    for (const timeout of this.gitOperationTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.gitOperationTimeouts.clear();
    this.gitStates.clear();
  }
}