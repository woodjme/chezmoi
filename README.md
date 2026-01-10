# Dotfiles

## Installation

### Install chezmoi

```bash
sh -c "$(curl -fsLS get.chezmoi.io)"
```

Add chezmoi to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Initialize dotfiles

You can use either SSH or HTTPS depending on whether you need to push changes:

#### Option 1: SSH (recommended - allows committing changes)

If you have SSH keys configured or plan to use 1Password for SSH:

```bash
chezmoi init git@github.com:woodjme/chezmoi.git
```

During setup, you'll be prompted:
- **Install 1Password for SSH keys?** Say yes if you want to use 1Password's SSH agent
- If yes and you're using HTTPS, you'll be asked if you want to switch to SSH after 1Password is configured

#### Option 2: HTTPS (simpler, read-only)

If you don't need to push changes or don't have SSH keys:

```bash
chezmoi init https://github.com/woodjme/chezmoi
```

During setup, when prompted **Install 1Password for SSH keys?** answer no.

Note: With HTTPS, you can pull updates but won't be able to push changes back to the repo.

### Switching from HTTPS to SSH later

If you started with HTTPS and want to switch to SSH:

```bash
cd $(chezmoi source-path)
git remote set-url origin git@github.com:woodjme/chezmoi.git
```
