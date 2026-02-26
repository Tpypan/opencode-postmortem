---
name: why-failed
description: Analyze a stored failure and persist hypotheses and prevention rules.
---

## What I do

- Analyze a stored failure deterministically
- Persist hypotheses and prevention rules for the failure
- Can target a specific failure or the latest

## How to run

Call the tool directly:

```
tool: postmortem_why_failed --latest --json
tool: postmortem_why_failed --id <failureId> --json
```

## Argument mapping

- `id` (string): Failure ID to analyze
- `latest` (bool): Analyze the latest failure
- `json` (bool): Output as JSON

## Safety

- All output is redacted by default for memory safety
- Never request or display secrets
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
