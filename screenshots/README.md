# Screenshots Guide

This folder contains screenshots for the DevOrb README and marketplace listing.

## Recommended Screenshots

### 1. Extension in Action (`extension-overview.png`)
- VS Code with DevOrb tree view open
- Show several .env files with sync status icons
- Include the sidebar showing environment variables
- **Size**: 1200x800px or larger

### 2. Settings Panel (`settings-panel.png`)
- VS Code Settings page with DevOrb configuration
- Show the 1Password integration settings
- Highlight the service account token field (with token hidden)
- **Size**: 1000x700px

### 3. 1Password Integration (`onepassword-integration.png`)
- DevOrb vault in 1Password showing environment variables
- Items with the "devorb" tag visible
- Clean, organized view
- **Size**: 1000x600px

### 4. Command Palette (`command-palette.png`)
- VS Code Command Palette open with DevOrb commands visible
- Show commands like "DevOrb: Setup 1Password Integration"
- **Size**: 800x500px

### 5. Context Menu (`context-menu.png`)
- Right-click menu on a .env file showing DevOrb options
- "Sync to 1Password", "Download from 1Password" options visible
- **Size**: 600x400px

### 6. Before/After Sync (`sync-comparison.png`)
- Split view showing local .env file and 1Password vault
- Demonstrate how variables sync between them
- **Size**: 1200x600px

## Image Guidelines

- Use consistent VS Code theme (preferably Dark+ or similar)
- Blur or redact any real API keys or sensitive data
- Use example variables like `API_KEY=sk_test_xxx` or `DATABASE_URL=postgresql://...`
- Ensure high contrast and readability
- Use PNG format for crisp screenshots
- Include realistic but fake data for demonstration

## Adding Screenshots to README

Once you have the screenshots, update the README.md with:

```markdown
## 📸 Screenshots

### DevOrb in Action
![DevOrb Extension Overview](screenshots/extension-overview.png)

### Easy 1Password Integration
![1Password Integration](screenshots/onepassword-integration.png)

### Simple Configuration
![Settings Panel](screenshots/settings-panel.png)
```