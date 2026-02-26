# Minimal Playbooks

These playbooks show practical command sequences for common situations.

## Playbook 1: Investigate a fresh failure

Goal: capture context, persist failure memory, and derive prevention rules.

```text
/inspect --json --errors
/record-failure --yes --reason "reproducible in CI" --tags ci --tags regression --json
/why-failed --latest --json
/rules --action add_from_failure --failureId <failure-id> --json
/rules --action list --json
```

## Playbook 2: Retry with controlled guardrails

Goal: run a safe retry with visibility into why rules were selected.

```text
/retry --explain
/retry --skip <rule-id> --skip <rule-id> --explain
/retry --yes
```

## Playbook 3: Housekeeping and retention

Goal: keep postmortem memory useful and bounded.

```text
/failures --action list --json
/failures --action prune --dryRun --olderThanDays 30 --keepLastN 200 --maxBytes 5000000 --json
/failures --action prune --olderThanDays 30 --keepLastN 200 --maxBytes 5000000 --json
/postmortem-eval --window 20 --json
```

## Playbook 4: Temporary quiet mode

Goal: pause lesson injection for one session, then restore normal behavior.

```text
/disable-lessons --json
/disable-lessons --enable --json
```
