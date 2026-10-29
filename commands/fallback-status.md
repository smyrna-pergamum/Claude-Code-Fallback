---
description: Show which provider cc-fallback is using and which ones are paused
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-fallback.js" status`

Summarize the cc-fallback status above in two or three lines: active mode, last provider used, and any paused providers with the time left. If the proxy is not running, tell the user to start Claude Code with `cc-fallback run`.
