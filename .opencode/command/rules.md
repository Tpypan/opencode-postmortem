---
description: Manage stored postmortem guardrail rules (list/show/enable/disable/edit/rate/add_from_failure)
model: opencode/kimi-k2.5
subtask: true
---

/rules

Call the `postmortem_rules` plugin tool with flags mapped from `$ARGUMENTS`. Example:

tool: postmortem_rules --action list --json
