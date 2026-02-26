---
name: rules
description: List, show, enable, disable, edit, or rate postmortem rules and import suggestions from failure analysis.
---

## What I do

- List, show, enable, disable, edit, or rate postmortem rules
- Import suggestions from failure analysis
- Filter, update, or rate rules by ID or failure

## How to run

Call the tool directly:

```
tool: postmortem_rules --action list --json
tool: postmortem_rules --action disable --id <ruleId> --json
tool: postmortem_rules --action edit --id <ruleId> --text "..." --json
```

## Argument mapping

- `action` (string): Action to perform (list, show, enable, disable, edit, rate, import)
- `id` (string): Rule ID
- `failureId` (string): Filter by failure
- `json` (bool): Output as JSON
- `includeDisabled` (bool): Include disabled rules
- `text` (string): Rule text
- `severity` (string): Severity level
- `rating` (string): Rule rating
- `note` (string): Add a note

## Safety

- All output is redacted by default for memory safety
- Never request or display secrets
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
