# `/failures`

When to use:

- You want to list, inspect, delete, or prune stored failures.

Examples:

```text
/failures --action list --json
/failures --action show --id <failure-id> --json
/failures --action delete --id <failure-id> --json
/failures --action prune --dryRun --olderThanDays 30 --keepLastN 200 --maxBytes 5000000 --json
/failures --action purge --yes --json
```
