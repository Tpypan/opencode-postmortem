# OpenCode Postmortem Plugin

This repository is a standalone OpenCode plugin distribution (not the OpenCode source tree).

It adds a postmortem workflow to OpenCode so you can inspect failed runs, store failure memory, generate prevention rules, and retry with bounded guardrails.

## What this plugin adds

- `postmortem_inspect`: view the latest redacted last-run snapshot
- `postmortem_record_failure`: persist a durable failure record
- `postmortem_why_failed`: deterministic analysis + 1-3 prevention rules
- `postmortem_rules`: list/show/enable/disable/edit/rate/import rules
- `postmortem_failures`: list/show/forget/delete/prune/purge failures
- `postmortem_retry`: generate a retry prompt with relevant guardrails (`--explain` supported)
- `postmortem_disable_lessons`: disable/enable injection for the current session
- `postmortem_config`: show/set storage mode (`user` or `repo`)
- `postmortem_eval`: local-only repeat-failure evaluation metrics

This repo also includes command wrappers in `.opencode/commands/` and skills in `.opencode/skills/`.

## Repository layout

- `.opencode/plugins/postmortem.ts`: plugin entrypoint loaded by OpenCode
- `.opencode/commands/*.md`: slash command templates
- `.opencode/skills/*/SKILL.md`: skill definitions
- `packages/postmortem-plugin/src`: plugin implementation
- `packages/postmortem-plugin/test`: test suite

## Install in your OpenCode project

From your project root, copy this repo's plugin files into your project:

```bash
cp -R /path/to/opencode-postmortem/.opencode .
mkdir -p packages
cp -R /path/to/opencode-postmortem/packages/postmortem-plugin packages/
```

Install plugin dependencies:

```bash
bun install --cwd packages/postmortem-plugin
```

Then restart OpenCode.

Notes:
- OpenCode loads project plugins from `.opencode/plugins/`.
- OpenCode loads project commands from `.opencode/commands/`.
- OpenCode loads project skills from `.opencode/skills/<name>/SKILL.md`.

## Quick usage

In OpenCode:

- `/inspect`
- `/record-failure --yes --json`
- `/why-failed --latest --json`
- `/rules --action list --json`
- `/retry --explain`
- `/retry --yes`

## Storage and safety

- Default storage is user-data scoped by project ID.
- Optional repo-local storage can be enabled with `.opencode/postmortem.json` and `{"storage":"repo"}`.
- Redaction and caps are applied before persistence and before display/injection.

## Validate install

If your OpenCode CLI has debug commands available:

```bash
opencode debug skill
opencode debug config
```

You should see postmortem skills and command templates in the resolved config.

## References

- Plugins docs: `https://opencode.ai/docs/plugins`
- Commands docs: `https://opencode.ai/docs/commands`
- Skills docs: `https://opencode.ai/docs/skills`
