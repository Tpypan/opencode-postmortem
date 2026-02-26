---
description: Deterministically analyze a stored failure and generate typed hypotheses + prevention rules
model: opencode/kimi-k2.5
subtask: true
---

/why-failed

Call the `postmortem_why_failed` plugin tool with flags mapped from `$ARGUMENTS`. Example:

tool: postmortem_why_failed --latest --json
