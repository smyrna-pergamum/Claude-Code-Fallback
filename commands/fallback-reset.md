---
description: Clear cc-fallback cooldowns so Claude is tried again right away
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/cc-fallback.js" reset`

Tell the user in one line that all cooldowns were cleared and the next request will try providers in order, starting with Claude.
