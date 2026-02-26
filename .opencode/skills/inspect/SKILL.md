---
name: inspect
description: Render the last-run postmortem snapshot for this project. Safe by default.
---

## What I do

- Show the most recent postmortem snapshot for the current project
- Optionally include files, git status, or errors in the output
- Output is safe for memory by default (redacted)

## How to run

Call the tool directly:

```
tool: postmortem_inspect --json --files --git --errors
```
## Argument mapping

- `json` (bool): Output as JSON
- `files` (bool): Include file list
- `git` (bool): Include git status
- `errors` (bool): Include error details

## Safety

- All output is redacted by default for memory safety
- Never request or display secrets
- To delete all postmortem data, first run `tool: postmortem_config --action show --json` to get the `root` path, then delete it manually with `rm -rf "<root>"`.
- Repo-local storage is opt-in via `.opencode/postmortem.json`.
