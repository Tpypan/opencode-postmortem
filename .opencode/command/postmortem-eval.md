Command: postmortem_eval

Description:
  Local-only evaluation of repeat-failure metrics from stored failures.jsonl. Reads the project's postmortem store (no telemetry) and computes deterministic metrics.

Args:
  --json : output JSON
  --window <n> : lookahead window size (default 10)

Metrics:
  totalRecords
  uniqueSignatures
  repeatRateWithinWindow
  repeatCountsBySignature
