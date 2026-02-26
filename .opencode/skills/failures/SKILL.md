---
name: failures
description: List, show, forget, delete, prune, or purge stored postmortem failures.
---

## What I do

- List all stored postmortem failures
- Show, forget, delete, prune, or purge failures by ID or session
- Supports dry run and filtering

## How to run

Call the tool directly:

```
tool: postmortem_failures --action list --json
tool: postmortem_failures --action delete --id <failureId> --yes --json
```

## Argument mapping

- `action` (string): Action to perform (list, show, forget, delete, prune, purge)
- `id` (string): Failure ID
- `sessionId` (string): Session ID
- `json` (bool): Output as JSON
- `yes` (bool): Confirm destructive actions
- `dryRun` (bool): Preview changes
- `maxBytes` (number): Limit output size
- `olderThanDays` (number): Filter by age
- `keepLastN` (number): Keep last N failures

## Safety

- All output is redacted by default for memory safety
- Never request or display secrets
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
