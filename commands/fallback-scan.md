---
description: Scan this computer and recommend an open-source local model for Claude Code
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-fallback.js" scan`

Using the scan above, explain briefly: what hardware was found, which local model fits best and the command to install it, and which free cloud providers still need an API key (with the environment variable name). Keep it short.
