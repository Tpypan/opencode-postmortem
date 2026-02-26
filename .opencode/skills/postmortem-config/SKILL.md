---
name: postmortem-config
description: Show or set project-local postmortem storage config (user or repo root).
---

## What I do

- Show or set the postmortem storage configuration for this project
- Switch between user and repo storage, or set raw storage
- Can output as JSON for scripting

## How to run

Call the tool directly:

```
tool: postmortem_config --action show --json
tool: postmortem_config --action set --storage repo --json
```

## Argument mapping

- `action` (string): Action to perform (show, set)
- `storage` (string): Storage location (user, repo)
- `storeRaw` (bool): Store raw data
- `json` (bool): Output as JSON

## Safety

- All output is redacted by default for memory safety
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
