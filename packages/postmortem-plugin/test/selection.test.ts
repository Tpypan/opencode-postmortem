import { describe, expect, test } from "bun:test"
import type { GuardrailRule } from "../src/model"
import { contextFromSnapshot, selectGuardrails } from "../src/selection"
import type { LastRunSnapshot } from "../src/snapshot/model"

function rule(input: {
  id: string
  enabled?: boolean
  signatures?: string[]
  paths?: string[]
  tools?: string[]
  keywords?: string[]
  rating?: "positive" | "negative"
  text?: string
}): GuardrailRule {
  return {
    id: input.id,
    enabled: input.enabled ?? true,
    match: {
      ...(input.signatures ? { signatures: input.signatures } : {}),
      ...(input.paths ? { paths: input.paths } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.keywords ? { keywords: input.keywords } : {}),
    },
    rule: {
      text: input.text ?? `guardrail ${input.id}`,
      severity: "should",
    },
    ...(input.rating ? { userFeedbackRating: input.rating } : {}),
  }
}

describe("selection", () => {
  test("derives context deterministically from snapshot", () => {
    const snapshot: LastRunSnapshot = {
      schemaVersion: 1,
      projectId: "project-1",
      sessionID: "session-1",
      capturedAt: "2026-01-01T00:00:00.000Z",
      errorSignature: "0123456789abcdef",
      tools: [
        { tool: "Bash", status: "error", durationMs: 10 },
        { tool: "Read", status: "completed", durationMs: 5 },
        { tool: "bash", status: "completed", durationMs: 6 },
      ],
      errors: [{ tool: "bash", snippet: "ENOENT file not found in src/main.ts" }],
      diff: {
        totalFiles: 1,
        additions: 5,
        deletions: 2,
        files: [{ file: "src/main.ts", additions: 5, deletions: 2 }],
      },
      gitStatus: {
        lines: [" M src/extra.ts", "R  src/old.ts -> src/new.ts"],
        truncated: false,
      },
      contextGaps: ["Missing file or incorrect path in workspace context."],
      meta: {
        droppedDueToCaps: false,
        droppedSections: [],
        source: {
          messageCount: 1,
          toolCallCount: 2,
          diffFileCount: 1,
          gitRepo: true,
        },
      },
    }

    const context = contextFromSnapshot(snapshot)
    expect(context.signatures).toEqual(["0123456789abcdef"])
    expect(context.paths).toEqual(["src/extra.ts", "src/main.ts", "src/new.ts"])
    expect(context.tools).toEqual(["bash", "read"])
    expect(context.keywords).toContain("enoent")
    expect(context.keywords).toContain("workspace")
  })

  test("selects deterministically under cap with stable trace reasons", () => {
    const rules = [
      rule({ id: "b-rule", signatures: ["sig-1"], text: "B".repeat(56) }),
      rule({ id: "a-rule", signatures: ["sig-1"], text: "A".repeat(56) }),
      rule({ id: "negative-rule", signatures: ["sig-1"], rating: "negative" }),
      rule({ id: "skip-rule", signatures: ["sig-1"] }),
      rule({ id: "disabled-rule", signatures: ["sig-1"], enabled: false }),
      rule({ id: "unmatched-rule", keywords: ["never-matches"] }),
    ]
    const context = {
      signatures: ["sig-1"],
      paths: ["src/main.ts"],
      tools: ["bash"],
      keywords: ["enoent", "workspace"],
    }

    const uncapped = selectGuardrails({
      rules,
      context,
      tokenCap: 10_000,
      skipIds: ["skip-rule"],
    })
    const a = uncapped.trace.find((item) => item.id === "a-rule")
    const b = uncapped.trace.find((item) => item.id === "b-rule")
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (!a || !b) throw new Error("expected seed traces")

    const capped = selectGuardrails({
      rules,
      context,
      tokenCap: a.tokenEstimate,
      skipIds: ["skip-rule"],
    })

    expect(capped.selectedIds).toEqual(["a-rule"])
    expect(capped.tokenEstimate).toBeLessThanOrEqual(capped.tokenCap)

    const traceById = Object.fromEntries(capped.trace.map((item) => [item.id, item]))
    expect(traceById["a-rule"].selected).toBeTrue()
    expect(traceById["b-rule"].dropReason).toBe("token_cap")
    expect(traceById["skip-rule"].dropReason).toBe("skip_list")
    expect(traceById["disabled-rule"].dropReason).toBe("disabled")
    expect(traceById["unmatched-rule"].dropReason).toBe("non_positive_score")
    expect(traceById["negative-rule"].score).toBeLessThan(traceById["a-rule"].score)

    for (const item of capped.trace) {
      expect(typeof item.id).toBe("string")
      expect(typeof item.score).toBe("number")
      expect(typeof item.matchCounts.signatures).toBe("number")
      expect(typeof item.matchCounts.paths).toBe("number")
      expect(typeof item.matchCounts.tools).toBe("number")
      expect(typeof item.matchCounts.keywords).toBe("number")
      expect(typeof item.tokenEstimate).toBe("number")
      expect(typeof item.selected).toBe("boolean")
    }
  })
})
