import { describe, expect, test } from "bun:test"
import { DEFAULT_SNAPSHOT_TOTAL_BYTES } from "../src/redaction"
import { buildLastRunSnapshot } from "../src/snapshot/build"

describe("last-run snapshot builder", () => {
  test("builds bounded redacted summary from messages and diffs", () => {
    const diffs = [
      {
        file: "src/snapshot/build.ts",
        additions: 12,
        deletions: 4,
        before: "API_KEY=should-not-be-stored",
        after: "API_KEY=should-not-be-stored",
      },
    ]

    const snapshot = buildLastRunSnapshot({
      projectId: "project_abc",
      sessionID: "session_123",
      messages: [
        {
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "completed",
                time: {
                  start: 100,
                  end: 260,
                },
              },
            },
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "error",
                error: "ENOENT: no such file or directory and API_KEY=top-secret",
                time: {
                  start: 300,
                  end: 410,
                },
              },
            },
          ],
        },
      ],
      diffs,
      gitStatusLines: [" M src/snapshot/build.ts", "?? .env"],
    })

    expect(snapshot.tools).toEqual([
      {
        tool: "bash",
        status: "completed",
        durationMs: 160,
      },
      {
        tool: "bash",
        status: "error",
        durationMs: 110,
      },
    ])
    expect(snapshot.errors).toHaveLength(1)
    expect(snapshot.errors[0].snippet).toContain("ENOENT")
    expect(snapshot.errors[0].snippet).not.toContain("top-secret")
    expect(snapshot.diff.files).toEqual([
      {
        file: "src/snapshot/build.ts",
        additions: 12,
        deletions: 4,
      },
    ])
    expect(snapshot.diff.totalFiles).toBe(1)
    expect(snapshot.contextGaps).toContain("Missing file or incorrect path in workspace context.")
    expect(snapshot.gitStatus?.lines).toEqual(["M src/snapshot/build.ts", "?? .env"])

    const encoded = JSON.stringify(snapshot)
  expect(encoded).not.toContain("should-not-be-stored")
  expect(encoded).not.toContain("\"before\"")
  expect(encoded).not.toContain("\"after\"")

  // errorSignature should be present when there are errors and be a short hex string
  expect(typeof snapshot.errorSignature).toBe("string")
  expect(snapshot.errorSignature).toMatch(/^[0-9a-f]{16,32}$/)
  // deterministic: building again yields the same signature
  const snapshot2 = buildLastRunSnapshot({
    projectId: "project_abc",
    sessionID: "session_123",
    messages: [
      {
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", time: { start: 100, end: 260 } },
          },
          {
            type: "tool",
            tool: "bash",
            state: { status: "error", error: "ENOENT: no such file or directory and API_KEY=top-secret", time: { start: 300, end: 410 } },
          },
        ],
      },
    ],
    diffs,
    gitStatusLines: [" M src/snapshot/build.ts", "?? .env"],
  })
  expect(snapshot2.errorSignature).toBe(snapshot.errorSignature)
  })

  test("compacts oversized snapshots deterministically", () => {
    const toolNames = {
      bash: `bash-${"b".repeat(155)}`,
      read: `read-${"r".repeat(155)}`,
      grep: `grep-${"g".repeat(155)}`,
      edit: `edit-${"e".repeat(155)}`,
    }

    const messages = [
      {
        parts: Array.from({ length: 900 }, (_, index) => {
          const mod = index % 4
          if (mod === 0) {
            return {
              type: "tool",
              tool: toolNames.bash,
              state: {
                status: "error",
                error:
                  index % 16 === 0
                    ? `fatal: parser exploded ${"x".repeat(2000)}`
                    : `fatal:   parser   exploded ${"x".repeat(2000)}`,
                time: {
                  start: index,
                  end: index + 100,
                },
              },
            }
          }
          if (mod === 1) {
            return {
              type: "tool",
              tool: toolNames.read,
              state: {
                status: "running",
                time: {
                  start: index,
                  end: index + 75,
                },
              },
            }
          }
          if (mod === 2) {
            return {
              type: "tool",
              tool: toolNames.grep,
              state: {
                status: "pending",
                time: {
                  start: index,
                  end: index + 50,
                },
              },
            }
          }
          return {
            type: "tool",
            tool: toolNames.edit,
            state: {
              status: "completed",
              time: {
                start: index,
                end: index + 25,
              },
            },
          }
        }),
      },
    ]

    const alphabet = "abcdefghijklmnopqrstuvwxyz"
    const label = (value: number) => {
      const a = alphabet[value % 26]
      const b = alphabet[Math.floor(value / 26) % 26]
      const c = alphabet[Math.floor(value / (26 * 26)) % 26]
      return `${c}${b}${a}`
    }

    const diffs = Array.from({ length: 700 }, (_, index) => {
      const bucket = index % 350
      const file = `src/${label(bucket)}/${alphabet[bucket % 26]}-${"a".repeat(420)}.ts`
      return {
        file,
        additions: (bucket % 7) + 1,
        deletions: bucket % 3,
      }
    })

    const input = {
      projectId: "project_compact",
      sessionID: "session_compact",
      capturedAt: "2026-03-01T00:00:00.000Z",
      messages,
      diffs,
      gitStatusLines: Array.from(
        { length: 250 },
        (_, index) => ` M ${"g".repeat(500)}-${index}.ts`,
      ),
    }

    const snapshot = buildLastRunSnapshot(input)
    const snapshot2 = buildLastRunSnapshot(input)

    expect(snapshot).toEqual(snapshot2)
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(
      DEFAULT_SNAPSHOT_TOTAL_BYTES,
    )

    expect(snapshot.tools.map((item) => item.tool)).toEqual([
      toolNames.bash,
      toolNames.read,
      toolNames.grep,
      toolNames.edit,
    ])
    expect(snapshot.tools.map((item) => item.status)).toEqual([
      "error",
      "running",
      "pending",
      "completed",
    ])

    expect(
      new Set(
        snapshot.errors.map(
          (item) => `${item.tool}:${item.snippet.replace(/\s+/g, " ").trim()}`,
        ),
      ).size,
    ).toBe(snapshot.errors.length)
    expect(snapshot.errors.length).toBeLessThanOrEqual(2)

    snapshot.diff.files.forEach((item, index, list) => {
      if (index === 0) return
      const prev = list[index - 1]
      const prevImpact = prev.additions + prev.deletions
      const impact = item.additions + item.deletions
      expect(prevImpact >= impact).toBeTrue()
      if (prevImpact === impact) expect(prev.file <= item.file).toBeTrue()
    })

    expect(snapshot.meta.droppedDueToCaps).toBeTrue()
    expect(snapshot.meta.droppedSections).toContain("tools")
    expect(snapshot.meta.droppedSections).toContain("errors")
  })

  test("supports redact=false for raw snapshot output", () => {
    const input = {
      projectId: "project_abc",
      sessionID: "session_123",
      messages: [
        {
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "error",
                error: "failed with API_KEY=top-secret",
              },
            },
          ],
        },
      ],
      diffs: [],
    }

    const redacted = buildLastRunSnapshot(input)
    const raw = buildLastRunSnapshot(input, { redact: false })

    expect(redacted.errors[0]?.snippet).not.toContain("top-secret")
    expect(raw.errors[0]?.snippet).toContain("top-secret")
  })
})
