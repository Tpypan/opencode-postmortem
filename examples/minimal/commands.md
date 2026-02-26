# Command Usage Guide

This is the detailed reference for every slash command installed by `npx postmortem-init`.

Conventions used in this guide:

- Add `--json` when you need machine-readable output.
- `failure-id` values come from `/failures --action list --json`.
- `rule-id` values come from `/rules --action list --json`.

For workflow-level examples, see `playbooks.md`.

## `/inspect`

Purpose: show the latest redacted postmortem snapshot for the current project.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | `false` | Return full structured snapshot payload. |
| `--files` | boolean | `false` | Include per-file diff details. |
| `--git` | boolean | `false` | Include captured git status lines. |
| `--errors` | boolean | `false` | Include detailed error snippets instead of tool-only error summary. |

Examples:

```text
/inspect
/inspect --errors
/inspect --files --git --json
```

## `/record-failure`

Purpose: preview or persist a durable failure record from the latest snapshot.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--yes` | boolean | `false` | Persist the record. Without this flag, the command runs in preview mode only. |
| `--json` | boolean | `false` | Return structured output (including dedupe and storage metadata). |
| `--reason <text>` | string | unset | Attach operator context for why this failure matters. |
| `--tags <tag>` | string (repeatable) | unset | Add one or more tags (for example `ci`, `flaky`, `regression`). |

Examples:

```text
/record-failure
/record-failure --reason "fails only on CI" --tags ci --tags flaky
/record-failure --yes --json
```

## `/why-failed`

Purpose: generate deterministic hypotheses and prevention-rule suggestions for a stored failure.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--id <failure-id>` | string | unset | Analyze a specific failure record by ID. |
| `--latest` | boolean | `true` behavior when no `--id` | Explicitly target the newest failure. |
| `--json` | boolean | `false` | Return hierarchy, hypotheses, and generated rule suggestions as JSON. |

Examples:

```text
/why-failed --latest --json
/why-failed --id <failure-id>
```

## `/rules`

Purpose: manage guardrail rules (list, inspect, mutate, and import from analysis).

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--action <list|show|enable|disable|edit|rate|add_from_failure>` | enum | `list` | Rule operation to perform. |
| `--id <rule-id>` | string | required for `show/enable/disable/edit/rate` | Target rule ID for rule-specific operations. |
| `--failureId <failure-id>` | string | required for `add_from_failure` | Failure record to import suggested rules from. |
| `--includeDisabled` | boolean | `false` | Include disabled rules in list output. |
| `--text <rule-text>` | string | unset | New rule text when editing. |
| `--severity <must|should>` | enum | unset | New severity when editing. |
| `--rating <positive|negative>` | enum | required for `rate` | User feedback rating on a rule. |
| `--note <text>` | string | unset | Optional feedback note for `rate`. |
| `--json` | boolean | `false` | Return structured payload. |

Action requirements:

- `show`, `enable`, `disable`, `edit`, and `rate` require `--id`.
- `add_from_failure` requires `--failureId`.
- `edit` requires at least one of `--text` or `--severity`.
- `rate` requires `--rating`.

Examples:

```text
/rules --action list --json
/rules --action show --id <rule-id> --json
/rules --action add_from_failure --failureId <failure-id> --json
/rules --action edit --id <rule-id> --severity must --text "Validate env before running" --json
/rules --action rate --id <rule-id> --rating positive --note "prevented recurrence" --json
```

## `/failures`

Purpose: manage stored failure records and retention.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--action <list|show|forget|delete|prune|purge>` | enum | `list` | Failure-store operation. |
| `--id <failure-id>` | string | required for `show/forget/delete` | Target failure ID. |
| `--sessionId <session-id>` | string | unset | Filter list output to one session. |
| `--json` | boolean | `false` | Return structured payload. |
| `--yes` | boolean | `false` | Required safety confirmation for `purge`. |
| `--dryRun` | boolean | `false` | For `prune`: show what would be removed without writing changes. |
| `--olderThanDays <n>` | integer | unset | For list/prune filtering by age. |
| `--keepLastN <n>` | integer | unset | For prune: keep only newest N records. |
| `--maxBytes <n>` | integer | unset | For prune: cap retained failure-store size by bytes. |

Action requirements:

- `show`, `forget`, and `delete` require `--id`.
- `purge` requires `--yes`.

Examples:

```text
/failures --action list --json
/failures --action show --id <failure-id> --json
/failures --action forget --id <failure-id> --json
/failures --action delete --id <failure-id> --json
/failures --action prune --dryRun --olderThanDays 30 --keepLastN 200 --maxBytes 5000000 --json
/failures --action prune --olderThanDays 30 --keepLastN 200 --maxBytes 5000000 --json
/failures --action purge --yes --json
```

## `/forget`

Purpose: shortcut wrapper for forgetting a failure ID.

Equivalent tool call:

```text
postmortem_failures --action forget --id <failure-id>
```

Example:

```text
/forget <failure-id>
```

## `/retry`

Purpose: preview or emit a guardrailed retry prompt based on session history and active rules.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--yes` | boolean | `false` | Emit the retry prompt. Without this flag, command stays in preview mode. |
| `--explain` | boolean | `false` | Include guardrail selection trace. |
| `--skip <rule-id>` | string (repeatable) | unset | Exclude one or more rule IDs from selection for this retry. |
| `--json` | boolean | `false` | Return selection metadata and prompt payload as JSON. |

Examples:

```text
/retry
/retry --explain
/retry --skip <rule-id> --skip <rule-id> --explain
/retry --yes --json
```

## `/disable-lessons`

Purpose: disable or re-enable postmortem lesson injection for the current session.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--disable` | boolean | default action | Explicitly disable lessons for the active session. |
| `--enable` | boolean | `false` | Re-enable lessons for the active session. |
| `--json` | boolean | `false` | Return session state as JSON. |

Notes:

- Running `/disable-lessons` with no flags disables lessons.
- Do not pass both `--disable` and `--enable` together.

Examples:

```text
/disable-lessons --json
/disable-lessons --enable --json
```

## `/postmortem-config`

Purpose: show or set postmortem storage configuration.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--action <show|set>` | enum | `show` | Display current config or write config changes. |
| `--storage <user|repo>` | enum | unset | Storage mode to set when `action=set`. |
| `--storeRaw` | boolean | unset | Enable raw snapshot storage when set. |
| `--json` | boolean | `false` | Return structured config and resolved storage paths. |

Notes:

- `action=set` requires at least one of `--storage` or `--storeRaw`.
- Setting `--storage repo` performs symlink safety checks.

Examples:

```text
/postmortem-config --action show --json
/postmortem-config --action set --storage repo --json
/postmortem-config --action set --storeRaw --json
```

## `/postmortem-eval`

Purpose: compute local repeat-failure metrics from stored failures.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | `false` | Return structured metrics payload. |
| `--window <n>` | integer | `10` | Lookahead window used to compute repeat rate. |

Examples:

```text
/postmortem-eval
/postmortem-eval --window 20 --json
```
