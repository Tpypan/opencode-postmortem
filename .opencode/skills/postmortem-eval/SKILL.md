---
name: postmortem-eval
description: Local-only evaluation of repeat-failure metrics from stored failures.jsonl.
---

## What I do

- Evaluate repeat-failure metrics from stored failures
- Operates locally, no remote calls
- Can limit the evaluation window

## How to run

Call the tool directly:

```
tool: postmortem_eval --json --window 30
```
## Argument mapping

- `json` (bool): Output as JSON
- `window` (number): Limit to last N days

## Safety

- All output is redacted by default for memory safety
- Never request or display secrets
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
