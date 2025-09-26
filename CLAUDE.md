# Project Memory

## Semantic Versioning & Release Process

### Branch-Based Automatic Versioning
This project uses semantic-release with automatic version detection based on branch naming patterns when PRs are merged to main.

**Branch naming conventions for automatic version bumps:**
- `feature/*` or `feat/*` → **Minor version bump** (1.1.0 → 1.2.0)
- `fix/*`, `bugfix/*`, `hotfix/*` → **Patch version bump** (1.1.0 → 1.1.1)
- `docs/*` → **Patch version bump** (documentation changes)
- `refactor/*` → **Patch version bump** (code refactoring)
- `test/*` → **Patch version bump** (test changes)
- `chore/*` → **No version bump** (maintenance)
- Any other branch → **Patch version bump** (safe default)

### Major Version Bumps (Manual Control)
For breaking changes requiring a major version bump:
- Add `BREAKING CHANGE:` or `BREAKING:` in the PR description or commit message
- This will bump from 1.x.x → 2.0.0

### Examples
```bash
# These branch names will auto-determine version bump:
feature/add-new-sync-provider  # → minor bump
fix/resolve-token-refresh      # → patch bump
hotfix/critical-security-fix   # → patch bump
chore/update-dependencies      # → no bump
```

### Release Configuration
- Release workflow: `.github/workflows/release.yml`
- Semantic-release config: `.releaserc.json`
- Automatic versioning happens on main branch pushes from PR merges
- No need to manually format commit messages - branch names control versioning