# pi-nats-chat — project tasks. Run `just` with no recipe to see this list.

ext_dir := env_var("HOME") + "/.pi/agent/extensions/nats-chat"

# Show available recipes.
default:
    @just --list

# Install npm dependencies locally (for development).
setup:
    npm install

# Symlink the project into ~/.pi/agent/extensions/ for development.
# Pi auto-discovers extensions here, and edits take effect on /reload.
link: setup
    #!/usr/bin/env bash
    set -euo pipefail
    target="{{ext_dir}}"
    target_dir="$(dirname "{{ext_dir}}")"
    mkdir -p "{{ext_dir}}"
    # Remove any existing copy or broken symlink
    rm -rf "{{ext_dir}}"
    ln -s "$(pwd)" "{{ext_dir}}"
    echo "Linked $(pwd) -> {{ext_dir}}"
    echo "Use /reload in Pi to pick up changes."

# Remove the development symlink.
unlink:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -L "{{ext_dir}}" ]]; then
        rm "{{ext_dir}}"
        echo "Removed {{ext_dir}}"
    else
        echo "{{ext_dir}} is not a symlink — nothing to unlink."
    fi

# Install into ~/.pi/agent/extensions/ as a permanent copy.
# Copies the project and runs npm install --omit=dev for production deps.
install:
    #!/usr/bin/env bash
    set -euo pipefail
    target="{{ext_dir}}"

    # Remove any existing symlink or copy
    rm -rf "{{ext_dir}}"
    mkdir -p "{{ext_dir}}"

    echo "Copying project to {{ext_dir}} ..."
    # Copy everything except node_modules, .git, and build artifacts
    rsync -a \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='justfile' \
        ./ "{{ext_dir}}/"

    echo "Installing production dependencies ..."
    cd "{{ext_dir}}" && npm install --omit=dev

    echo "Installed to {{ext_dir}}"
    echo "Start Pi — the extension loads automatically."

# Remove the installed copy from ~/.pi/agent/extensions/.
uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -d "{{ext_dir}}" ]]; then
        rm -rf "{{ext_dir}}"
        echo "Removed {{ext_dir}}"
    else
        echo "{{ext_dir}} not found — nothing to uninstall."
    fi
