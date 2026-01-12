#!/bin/bash

# Create ~/.zshrc.local if it doesn't exist
# This file is for machine-specific config and is NOT managed by chezmoi

LOCAL_ZSHRC="$HOME/.zshrc.local"

if [ ! -f "$LOCAL_ZSHRC" ]; then
    cat > "$LOCAL_ZSHRC" << 'EOF'
# Local machine-specific zsh configuration
# This file is NOT managed by chezmoi or tracked in git
# Add machine-specific aliases, environment variables, secrets, etc. here

# Example:
# export API_KEY="secret-key-here"

EOF
    echo "Created ~/.zshrc.local"
else
    echo "~/.zshrc.local already exists, skipping"
fi
