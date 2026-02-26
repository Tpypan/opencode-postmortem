---
description: Manage stored postmortem failures (list/show/forget/delete/prune/purge)
model: opencode/kimi-k2.5
subtask: true
---

/failures

Call the `postmortem_failures` plugin tool with flags mapped from `$ARGUMENTS`. Example:

tool: postmortem_failures --action list --json
