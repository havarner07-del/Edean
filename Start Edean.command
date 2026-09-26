#!/bin/bash
# Double-click to run Edean from source on macOS or Linux (needs Node.js 22+).
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then echo "Node.js is not installed. Get it from https://nodejs.org"; read -r; exit 1; fi
[ -d node_modules ] || { echo "Installing Edean's libraries..."; npm install --omit=dev || exit 1; }
exec node launcher.js
