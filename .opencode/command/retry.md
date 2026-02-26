---
description: Preview or emit a guardrailed retry prompt for the last user task
model: opencode/kimi-k2.5
subtask: true
---

/retry

Call the `postmortem_retry` plugin tool with flags mapped from $ARGUMENTS. Examples:

tool: postmortem_retry
tool: postmortem_retry --skip rule-a --skip rule-b --explain
tool: postmortem_retry --yes
