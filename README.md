# OpenCode Postmortem Plugin

`opencode-postmortem-plugin` adds a complete postmortem loop to OpenCode: capture failures, analyze root causes, create guardrails, and retry with context-aware constraints.

This repository is the standalone plugin distribution (not the OpenCode source tree).

## Why this plugin is useful

- Persist failure history across sessions instead of losing context after one run.
- Generate deterministic failure analysis and reusable prevention rules.
- Keep retries bounded and explainable (`/retry --explain`).
- Evaluate repeat-failure trends locally (`/postmortem-eval`) without telemetry.

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

## Install

See [INSTALL.md](INSTALL.md) for full setup.

Quick start:

1. Add `"opencode-postmortem-plugin"` to your `opencode.json` plugin array.
2. Run `npx postmortem-init` in your project.
3. Restart OpenCode.

## Usage examples

The sections below show realistic command sequences you can run in OpenCode.
For the full per-command catalog, see [commands.md](examples/minimal/commands.md).

### 1) Capture and analyze a failure in minutes

```text
/inspect --json --errors
/record-failure --yes --json
/why-failed --latest --json
```

Use this when a run fails and you want a durable record plus deterministic hypotheses before trying fixes.

### 2) Build guardrails, then retry with context

```text
/rules --action list --json
/retry --explain
/retry --yes
```

This sequence helps you review active rules, see why each rule was selected, then execute a guarded retry prompt.

### 3) Tune behavior during a long debugging session

```text
/disable-lessons --json
/disable-lessons --enable --json
/postmortem-config --action show --json
```

Use `/disable-lessons` when you want a temporary clean session, then re-enable guardrail injection when you are ready.

### 4) Manage failure memory and clean up stale records

```text
/failures --action list --json
/failures --action show --id <failure-id> --json
/forget <failure-id>
```

You can inspect specific incidents and retire low-value memory entries while preserving the rest of your history.

### 5) Evaluate if failures are repeating

```text
/postmortem-eval --json --window 20
```

This reports repeat-failure metrics so you can measure whether new rules are reducing recurrence.

## Examples folder

- `examples/minimal/opencode.json` - minimal plugin config for a project
- `examples/minimal/README.md` - minimal setup walkthrough
- `examples/minimal/commands.md` - description and example usage for every command

## Repository layout

- `src/` - plugin implementation (TypeScript source)
- `src/templates/` - command and skill templates copied by `postmortem-init`
- `test/` - test suite
- `scripts/` - init script source
- `examples/` - runnable configuration and command examples
- `dist/` - build output (npm ESM + bundled fallback)

## Storage and safety

- Default storage is user-data scoped by project ID.
- Optional repo-local storage can be enabled with `.opencode/postmortem.json` and `{ "storage": "repo" }`.
- Redaction and caps are applied before persistence and before display/injection.

## References

- Plugins docs: https://opencode.ai/docs/plugins
- Commands docs: https://opencode.ai/docs/commands
- Skills docs: https://opencode.ai/docs/skills
