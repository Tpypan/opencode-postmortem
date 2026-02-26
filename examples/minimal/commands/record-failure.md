# `/record-failure`

When to use:

- You want to persist a durable failure record from the latest snapshot.

Examples:

```text
/record-failure
/record-failure --reason "fails on CI only" --tags ci --tags flaky
/record-failure --yes --json
```
