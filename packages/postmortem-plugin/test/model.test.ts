import { describe, expect, test } from "bun:test"
import {
  EvidenceItem,
  FAILURE_RECORD_SCHEMA_VERSION,
  FailureRecord,
  GuardrailRule,
  MAX_REDACTED_TEXT,
  MAX_RULE_TEXT,
} from "../src/model"

describe("postmortem model schemas", () => {
  test("valid fixture passes", () => {
    const rec = {
      schemaVersion: FAILURE_RECORD_SCHEMA_VERSION,
      id: "fail_1",
      projectId: "proj_1",
      createdAt: new Date().toISOString(),
      sessionId: "sess_123",
      signature: { messageHash: "mhash" },
      evidence: [
        {
          type: "error",
          redactedText: "short",
          hash: "h",
          byteCount: 10,
          tokenEstimate: 2,
        },
      ],
    }

    expect(() => FailureRecord.parse(rec)).not.toThrow()
  })

  test("oversized redactedText fails", () => {
    const item = {
      type: "tool",
      redactedText: "x".repeat(MAX_REDACTED_TEXT + 1),
      hash: "h",
      byteCount: 1,
      tokenEstimate: 1,
    }

    expect(() => EvidenceItem.parse(item)).toThrow()
  })

  test("oversized rule text fails and severity enum validated", () => {
    const ok = {
      id: "rule_1",
      enabled: true,
      match: {},
      rule: { text: "a".repeat(MAX_RULE_TEXT), severity: "must" },
    }

    expect(() => GuardrailRule.parse(ok)).not.toThrow()

    const tooLong = { ...ok, rule: { text: "a".repeat(MAX_RULE_TEXT + 1), severity: "must" } }
    expect(() => GuardrailRule.parse(tooLong)).toThrow()

    const badSeverity: unknown = { ...ok, rule: { text: "ok", severity: "low" } }
    expect(() => GuardrailRule.parse(badSeverity)).toThrow()
  })

  test("unknown evidence type enum value is rejected", () => {
    const badType: unknown = {
      type: "unknown",
      redactedText: "short",
      hash: "h",
      byteCount: 1,
      tokenEstimate: 1,
    }

    expect(() => EvidenceItem.parse(badType)).toThrow()
  })
})
