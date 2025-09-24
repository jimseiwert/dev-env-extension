# Dev Environment Helper

A VS Code extension to help make developers' life easier by syncing Claude Code configurations across multiple machines.

## Features

### Claude Configuration Sync

Sync your Claude Code settings across multiple development machines using GitHub Gists. This includes:

- **Settings** - Claude global settings (`settings.json`)
- **Subagents** - Custom subagent definitions (`subagents.json`)
- **Hooks** - Hook configurations (`hooks.json`)
- **Slash Commands** - Custom slash command scripts
- **Plugins** - Plugin configurations
- **Project Memory** - CLAUDE.md files (optional)

#### Setup

1. **Enable Claude Sync**
   - Open VS Code Settings (`Ctrl/Cmd + ,`)
   - Search for "Claude Sync"
   - Check "Enable Claude configuration sync across machines"

2. **Authenticate with GitHub**
   - VS Code will automatically prompt you to sign in to GitHub when needed
   - Grant permission for `gist` access when prompted

3. **Choose Sync Items**
   - Select which Claude configurations to sync
   - By default, all core settings are enabled

#### Usage

- **Manual Sync**: Command Palette → "Claude Sync: Sync Now"
- **Auto Sync**: Automatically syncs when files change (configurable)
- **Status Check**: Command Palette → "Claude Sync: Show Status"

#### Security

- Uses private GitHub Gists for storage
- Excludes sensitive/machine-specific files:
  - Session data (`statsig/`)
  - Conversation history (`.jsonl` files)
  - IDE locks and temporary files
  - Shell snapshots

## Commands

- `Claude Sync: Sync Now` - Manually trigger sync
- `Claude Sync: Show Status` - View sync status
- `Claude Sync: Open Settings` - Open sync settings

## Requirements

- GitHub account for Gist storage
- Claude Code installed and configured

## Release Notes

### 0.0.1

- Initial release
- Claude configuration sync via GitHub Gists
- Configurable sync options
- Auto-sync with file watching