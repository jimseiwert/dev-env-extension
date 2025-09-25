# DevOrb

Your dev environment remembers across machines. DevOrb syncs Claude AI, GitHub Copilot, and environment configurations seamlessly between your development setups.

## Features

### AI Assistant Sync

Sync your Claude AI and GitHub Copilot configurations across multiple development machines using GitHub Gists. This includes:

- **Settings** - Claude global settings (`settings.json`)
- **Subagents** - Custom subagent definitions (`subagents.json`)
- **Hooks** - Hook configurations (`hooks.json`)
- **Slash Commands** - Custom slash command scripts
- **Plugins** - Plugin configurations
- **Project Memory** - CLAUDE.md files (optional)

#### Setup

1. **Enable DevOrb**
   - Open VS Code Settings (`Ctrl/Cmd + ,`)
   - Search for "DevOrb"
   - Check "Enable Claude configuration sync across machines"

2. **Authenticate with GitHub**
   - VS Code will automatically prompt you to sign in to GitHub when needed
   - Grant permission for `gist` access when prompted

3. **Choose Sync Items**
   - Select which Claude configurations to sync
   - By default, all core settings are enabled

#### Usage

- **Manual Sync**: Command Palette → "DevOrb: Sync Now"
- **Auto Sync**: Automatically syncs when files change (configurable)
- **Status Check**: Command Palette → "DevOrb: Show Status"

#### Security

- Uses private GitHub Gists for storage
- Excludes sensitive/machine-specific files:
  - Session data (`statsig/`)
  - Conversation history (`.jsonl` files)
  - IDE locks and temporary files
  - Shell snapshots

## Commands

- `DevOrb: Sync Now` - Manually trigger sync
- `DevOrb: Show Status` - View sync status
- `DevOrb: Open Settings` - Open sync settings

## Requirements

- GitHub account for Gist storage
- Claude AI and/or GitHub Copilot (depending on what you want to sync)

## Release Notes

### 0.0.1

- Initial release
- Claude AI configuration sync via GitHub Gists
- GitHub Copilot configuration sync support
- Environment file detection and management
- Configurable sync options with auto-sync
- Cross-machine development environment consistency

 ```mermaid
sequenceDiagram
      participant User as User
      participant Ext as VS Code Extension
      participant EnvView as Environment View Provider
      participant EnvSvc as Environment Service
      participant 1PSvc as 1Password Service
      participant 1P as 1Password API

      Note over User, 1P: Extension Startup Flow

      User->>Ext: VS Code starts extension
      Ext->>EnvSvc: initialize()
      EnvSvc->>1PSvc: initialize()
      Note over 1PSvc: No API calls - just creates client

      Ext->>EnvView: new EnvironmentViewProvider()
      Note over EnvView: Constructor - no API calls

      Note over Ext: Tree view registered - may trigger getChildren()
      EnvView->>EnvView: getChildren() → getRootItems()
      Note over EnvView: Shows "⏳ Loading..." if not initialized

      Note over User, 1P: Delayed Initialization (1 second)

      Ext->>EnvView: initialize() [after 1s delay]
      EnvView->>EnvView: findEnvironmentFiles()
      EnvView->>EnvView: buildLocalVariablesSet()
      Note over EnvView: Local operations only - no API calls
      EnvView->>EnvView: _onDidChangeTreeData.fire()

      Note over User, 1P: Remote Data Loading (5 second delay)

      Ext->>EnvView: loadRemoteDataAndSetupWatchers() [after 5s delay]
      EnvView->>EnvSvc: getRemoteSecrets()
      EnvSvc->>1PSvc: getEnvironmentSecrets()

      Note over 1PSvc, 1P: Core API Call Sequence

      1PSvc->>1PSvc: ensureDevOrbVault()
      alt Vault ID configured
          Note over 1PSvc: Return cached/configured vault ID - NO API CALL
      else No vault configured
          1PSvc->>1P: vaults.list() [rate limited, 3s gap]
          1P-->>1PSvc: vault list
          1PSvc->>1PSvc: find "DevOrb" vault or update config
      end

      1PSvc->>1P: items.list(vaultId) [rate limited, 3s gap]
      1P-->>1PSvc: all items in vault

      1PSvc->>1PSvc: filter items (devorb tag + active state)

      Note over 1PSvc, 1P: Parallel Detail Fetching

      par Item 1
          1PSvc->>1P: items.get(vaultId, item1) [rate limited]
          1P-->>1PSvc: item1 details
      and Item 2
          1PSvc->>1P: items.get(vaultId, item2) [rate limited]
          1P-->>1PSvc: item2 details
      and Item N
          1PSvc->>1P: items.get(vaultId, itemN) [rate limited]
          1P-->>1PSvc: itemN details
      end

      1PSvc->>1PSvc: repository filtering + caching
      1PSvc-->>EnvSvc: filtered secrets array
      EnvSvc-->>EnvView: RemoteSecret[]

      EnvView->>EnvView: setupFileWatcher()
      EnvView->>EnvView: _onDidChangeTreeData.fire()

      Note over User, 1P: User-Triggered Operations

      User->>Ext: Select Vault command
      Ext->>EnvSvc: getVaults()
      EnvSvc->>1PSvc: getVaults()
      1PSvc->>1P: vaults.list() [rate limited, 3s gap]
      1P-->>1PSvc: vault list
      1PSvc-->>Ext: vault options

      User->>Ext: Update secret value
      Ext->>EnvSvc: updateSecretValue(itemId, newValue)
      EnvSvc->>1PSvc: updateSecretValue()
      1PSvc->>1PSvc: ensureDevOrbVault() [cached - no API call]
      1PSvc->>1P: items.get(vaultId, itemId) [rate limited, 3s gap]
      1P-->>1PSvc: current item
      1PSvc->>1P: items.put(updatedItem) [rate limited, 3s gap]
      1P-->>1PSvc: success

      User->>Ext: Create new secret
      Ext->>EnvSvc: syncSingleVariable()
      EnvSvc->>1PSvc: createOrUpdateSecret()
      1PSvc->>1PSvc: ensureDevOrbVault() [cached - no API call]
      1PSvc->>1P: items.list(vaultId) [rate limited, 3s gap]
      1P-->>1PSvc: existing items
      1PSvc->>1PSvc: check for duplicates (local processing)
      1PSvc->>1P: items.create(newItem) [rate limited, 3s gap]
      1P-->>1PSvc: created item

      User->>Ext: Delete secret
      Ext->>EnvSvc: deleteSecret()
      EnvSvc->>1PSvc: deleteSecret()
      1PSvc->>1PSvc: ensureDevOrbVault() [cached - no API call]
      1PSvc->>1P: items.list(vaultId) [rate limited, 3s gap]
      1P-->>1PSvc: all items
      1PSvc->>1PSvc: find item to delete (local processing)
      1PSvc->>1P: items.delete(vaultId, itemId) [rate limited, 3s gap]
      1P-->>1PSvc: success

      Note over User, 1P: File Change Auto-Sync

      User->>+Ext: Edits .env file
      Ext->>EnvView: file watcher triggers
      EnvView->>EnvView: debouncedRefresh() [1s delay]
      EnvView->>EnvView: refresh()
      EnvView->>EnvSvc: getRemoteSecrets() [uses cache if fresh]
      Note over EnvView: May trigger full refresh cycle if cache expired

      Note over User, 1P: Rate Limiting & Circuit Breaker

      1PSvc->>1P: Any API call
      alt Rate limit exceeded
          1P-->>1PSvc: 429 Rate Limit Error
          1PSvc->>1PSvc: Open circuit breaker (30s)
          1PSvc->>1PSvc: All future calls rejected for 30s
      else Normal response
          1P-->>1PSvc: Success
          1PSvc->>1PSvc: 3s minimum gap before next call
      end
```      