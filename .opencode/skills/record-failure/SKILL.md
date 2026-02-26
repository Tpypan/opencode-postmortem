---
name: record-failure
description: Preview or persist a durable failure record from the last-run snapshot.
---

## What I do

- Record a failure event based on the most recent postmortem snapshot
- Optionally add a reason or tags
- Can preview or persist the record

## How to run

Call the tool directly:

```
tool: postmortem_record_failure --yes --json --reason "..." --tags foo --tags bar
```
## Argument mapping

- `yes` (bool): Persist immediately
- `json` (bool): Output as JSON
- `reason` (string): Reason for failure
- `tags` (string[]): Tags for this failure

## Safety

- All output is redacted by default for memory safety
- Never request or display secrets
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
