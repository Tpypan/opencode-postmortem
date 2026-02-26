# `/rules`

When to use:

- You want to inspect, tune, or import guardrail rules.

Examples:

```text
/rules --action list --json
/rules --action show --id <rule-id> --json
/rules --action add_from_failure --failureId <failure-id> --json
/rules --action edit --id <rule-id> --severity must --text "Validate inputs first" --json
/rules --action disable --id <rule-id> --json
```
