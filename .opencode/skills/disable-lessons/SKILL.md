---
name: disable-lessons
description: Disable or re-enable postmortem guardrail injection for this session.
---

## What I do

- Disable or re-enable postmortem guardrail lessons for the current session
- Can be toggled on or off as needed
- Safe for memory by default

## How to run

Call the tool directly:

```
tool: postmortem_disable_lessons
tool: postmortem_disable_lessons --enable
tool: postmortem_disable_lessons --disable
tool: postmortem_disable_lessons --json
```

## Argument mapping

- `disable` (bool): Disable lessons
- `enable` (bool): Enable lessons
- `json` (bool): Output as JSON

## Safety

- All output is redacted by default for memory safety
- Never request or display secrets
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
