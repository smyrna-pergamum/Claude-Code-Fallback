---
description: Force cc-fallback to a provider (claude, gemini, ollama, ...) or back to auto
argument-hint: <provider|auto>
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-fallback.js" use $ARGUMENTS`

Confirm in one line which provider is now active (or that automatic mode is back on). The change applies from the next message.
