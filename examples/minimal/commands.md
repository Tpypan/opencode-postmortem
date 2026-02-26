# Command Usage Guide

This guide shows what each postmortem command does and how to use it in an OpenCode session.

## `/inspect`

Use this to view the latest redacted postmortem snapshot for the current project.

Example:

```text
/inspect --json --errors
```

## `/record-failure`

Use this to persist a durable failure record from the latest snapshot.

Example:

```text
/record-failure --yes --json
```

## `/why-failed`

Use this to run deterministic analysis on a failure and generate typed hypotheses plus prevention rules.

Example:

```text
/why-failed --latest --json
```

## `/rules`

Use this to manage guardrail rules (list, show, enable, disable, edit, rate, add from failure).

Examples:

```text
/rules --action list --json
/rules --action show --id <rule-id> --json
/rules --action disable --id <rule-id> --json
/rules --action enable --id <rule-id> --json
```

## `/failures`

Use this to manage stored failures (list, show, forget, delete, prune, purge).

Examples:

```text
/failures --action list --json
/failures --action show --id <failure-id> --json
/failures --action prune --dry-run --older-than-days 30 --keep-last-n 200 --json
```

## `/forget`

Use this shortcut to forget a stored failure by ID.

Example:

```text
/forget <failure-id>
```

## `/retry`

Use this to preview or emit a guardrailed retry prompt for the latest user task.

Examples:

```text
/retry --explain
/retry --skip <rule-id> --skip <rule-id> --explain
/retry --yes
```

## `/disable-lessons`

Use this to disable or re-enable lesson injection for the active session.

Examples:

```text
/disable-lessons --json
/disable-lessons --enable --json
```

## `/postmortem-config`

Use this to view or set storage behavior.

Examples:

```text
/postmortem-config --action show --json
/postmortem-config --action set --storage repo --json
```

## `/postmortem-eval`

Use this to compute local repeat-failure metrics from stored failures.

Example:

```text
/postmortem-eval --json --window 20
```
