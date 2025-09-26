# 🌍 DevOrb

> **Your dev environment finally has a memory!** 🧠

Tired of setting up `.env` files on every new machine? Fed up with copying environment variables between your laptop, desktop, and that server you SSH into? DevOrb is here to save your sanity (and your secrets)!

This VS Code extension seamlessly syncs your environment variables across all your development machines using 1Password's rock-solid security. Because who has time to remember 47 different API keys? 🔐

<!-- ## 📸 See It In Action

> 🚧 **Screenshots coming soon!** We're putting the finishing touches on some beautiful screenshots to show you exactly how DevOrb works. Check back soon or see the `screenshots/` folder for our photography roadmap! 📷 -->

## ✨ Features

### 🔒 Secure Environment Variable Sync
- **Zero-Config Magic**: Automatically detects `.env`, `.env.local`, `.env.development`, and friends
- **1Password Integration**: Your secrets stay secure in your 1Password vault (because we're not monsters)
- **Smart Auto-Sync**: Updates everywhere when you change a variable anywhere
- **Multiple Projects**: Each project can have its own vault or share one - your choice!

### 🚀 What Gets Synced
- All your `.env` files and variants (`.env.local`, `.env.development`, etc.)
- Environment variables across unlimited development machines
- Project-specific configurations with optional prefixes
- Automatic file creation when you clone repositories

## 🎯 Getting Started

### Step 1: Get a 1Password Account
You'll need a 1Password account to store your environment variables securely. Don't have one?

👉 **[Sign up for 1Password](https://1password.com/sign-up/)**

*Pro tip: You can use the personal plan or get your company to pay for it! 💸*

### Step 2: Create Your DevOrb Vault
1. Log into your 1Password account
2. Create a new vault called **"DevOrb"** (exactly like that, case-sensitive!)
3. This is where all your environment variables will live

### Step 3: Get Your Service Account Token
1. Head over to the [1Password Developer Console](https://developer.1password.com/docs/service-accounts/)
2. Create a new Service Account
3. Give it access to your DevOrb vault
4. Copy that shiny new token (it starts with `ops_`)

### Step 4: Configure DevOrb
1. Install this extension (you probably already did this!)
2. Open VS Code Settings (`Ctrl/Cmd + ,`)
3. Search for "DevOrb"
4. Paste your service account token in the 1Password settings
5. Use the `DevOrb: Select 1Password Vault` command to choose your DevOrb vault

### Step 5: Profit! 📈
That's it! DevOrb will now:
- Scan your workspace for `.env` files
- Show you which variables are synced vs local-only
- Automatically sync changes across all your machines
- Create missing `.env` files when you switch between projects

## 🎮 Commands

| Command | What It Does | When To Use It |
|---------|--------------|----------------|
| `DevOrb: Setup 1Password Integration` | Walks you through the setup process | First time setup or if things break |
| `DevOrb: Set 1Password Service Account Token` | Add or update your token | When you get a new token |
| `DevOrb: Select 1Password Vault` | Choose which vault to use | Setting up or switching vaults |
| `DevOrb: Refresh & Sync Environment Files` | Force a full sync | When you want to make sure everything's up to date |
| `DevOrb: Sync All Environment Variables` | Push all local vars to 1Password | After making lots of changes |
| `DevOrb: Create Missing Environment Files` | Pull down missing .env files | When you clone a new project |
| `DevOrb: Open Settings` | Jump to DevOrb settings | When you need to tweak things |

### Keyboard Shortcuts
- `Ctrl+Alt+R` (or `Cmd+Alt+R` on Mac): Quick refresh and sync

### Context Menu Magic
Right-click on any `.env` file in the Explorer to:
- Sync that specific file to 1Password
- Download the latest version from 1Password
- Check sync status

## 🛡️ Security Features

- **Service Account Tokens**: Stored securely in VS Code's secret storage (not in your settings file!)
- **Vault Isolation**: Each project can use its own vault
- **Prefix Support**: Add prefixes like `myproject_` to avoid naming conflicts
- **Local Override**: Some variables can stay local-only (add them to `.gitignore` patterns)

## 🤝 Contributing

Found a bug? Want a feature? We'd love your help!

1. **Issues**: [Report bugs or request features](https://github.com/jimseiwert/devorb/issues)
2. **Development**:
   ```bash
   git clone https://github.com/jimseiwert/dev-orb-extension.git
   cd devorb
   npm install
   code .
   # Press F5 to run the extension in development mode
   ```
3. **Pull Requests**: Always welcome! Please include tests if adding new features.

### Development Setup
- Node.js 16+
- VS Code 1.74+
- TypeScript knowledge helpful but not required

## 📝 Requirements

- **VS Code**: Version 1.74.0 or newer
- **1Password Account**: Personal or business plan
- **Service Account**: With access to a DevOrb vault
- **Internet Connection**: For syncing (obviously! 🌐)

## 🎉 Release Notes

### 1.0.2 - The "Automated Publishing" Update
- 🤖 Fully automated semantic versioning with branch-based version detection
- 🚀 Automatic publishing to both VS Code Marketplace and OpenVSX Registry
- 🔄 Smart release workflows that detect feature/ and fix/ branches

### 1.0.0 - The "Finally Ready for Prime Time" Release
- 🎯 Full 1Password integration with service account support
- 🔄 Automatic environment file detection and syncing
- 🎨 Beautiful tree view showing sync status
- ⚡ Smart auto-sync with debouncing (no more spam!)
- 🛡️ Secure token storage in VS Code's secret storage
- 📁 Multi-project support with optional prefixes
- 🔧 Comprehensive settings UI
- 🎮 Full command palette integration
- ⌨️ Keyboard shortcuts for power users
- 🖱️ Context menu integration for .env files

---

**Made with lots of ☕ by [Jim Seiwert](https://github.com/jimseiwert)**

*P.S. - If this extension saves you time, consider starring the repo! It makes us happy and helps other developers find it. ⭐*