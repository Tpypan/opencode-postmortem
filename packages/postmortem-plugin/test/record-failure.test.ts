import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { renderRecordFailure } from "../src/record-failure"
import { LastRunSnapshot } from "../src/snapshot/model"
import { postmortemPaths } from "../src/storage/paths"
import { loadFailureRecords } from "../src/store/failures"

const dirs: string[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function setupSnapshot(name: string, snapshot: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `postmortem-record-${name}-`))
  dirs.push(dir)
  const parsed = LastRunSnapshot.parse(snapshot)
  const paths = await postmortemPaths(dir)
  roots.push(paths.defaultRoot)
  await fs.mkdir(paths.defaultRoot, { recursive: true })
  await fs.writeFile(path.join(paths.defaultRoot, "last-run.json"), JSON.stringify(parsed, null, 2), "utf8")
  return { worktree: dir, root: paths.defaultRoot }
}

function fixtureSnapshot(overrides: Partial<LastRunSnapshot> = {}): LastRunSnapshot {
  return LastRunSnapshot.parse({
    schemaVersion: 1,
    projectId: "proj_test",
    sessionID: "session_1",
    capturedAt: "2026-02-26T00:00:00.000Z",
    tools: [
      { tool: "build", status: "completed", durationMs: 1000 },
      { tool: "test", status: "error", durationMs: 400 },
    ],
    errors: [{ tool: "test", snippet: "AssertionError: expected true to be false" }],
    diff: {
      totalFiles: 2,
      additions: 20,
      deletions: 5,
      files: [
        { file: "src/a.ts", additions: 10, deletions: 2 },
        { file: "src/b.ts", additions: 10, deletions: 3 },
      ],
    },
    gitStatus: { lines: ["M src/a.ts", "M src/b.ts"], truncated: false },
    contextGaps: ["Missing required environment variable or secret."],
    meta: {
      droppedDueToCaps: false,
      droppedSections: [],
      source: { messageCount: 1, toolCallCount: 2, diffFileCount: 2, gitRepo: true },
    },
    ...overrides,
  })
}

describe("record-failure", () => {
  test("preview mode does not persist and asks for --yes", async () => {
    const setup = await setupSnapshot("preview", fixtureSnapshot())
    const out = await renderRecordFailure(setup.worktree)
    const records = await loadFailureRecords(setup.root)

    expect(out).toContain("PREVIEW")
    expect(out).toContain("--yes")
    expect(records.records).toHaveLength(0)
  })

  test("persist mode appends a record and writes summary", async () => {
    const setup = await setupSnapshot("persist", fixtureSnapshot())
    const out = await renderRecordFailure(setup.worktree, {
      yes: true,
      reason: "API_KEY=secret-value",
      tags: ["ci", "flaky", "ci"],
    })
    const records = await loadFailureRecords(setup.root)
    const summary = await fs.readFile(path.join(setup.root, "SUMMARY.md"), "utf8")

    expect(out).toContain("status: persisted")
    expect(records.records).toHaveLength(1)
    expect(summary).toContain("- Total records: 1")
    const trace = records.records[0]?.selectionTrace as { reason?: string; tags?: string[] } | undefined
    const analysis = records.records[0]?.analysis
    expect(trace?.reason).toContain("API_KEY=[REDACTED]")
    expect(trace?.tags).toEqual(["ci", "flaky"])
    expect(analysis).toBeDefined()
    expect(analysis?.rules.length).toBeGreaterThanOrEqual(1)
    expect(analysis?.rules.length).toBeLessThanOrEqual(3)
    expect(analysis?.rules.map((rule) => rule.text)).toEqual(
      expect.arrayContaining([
        "Validate required env vars before execution and fail fast when any required key is unset.",
        "Run targeted tests before merge and block changes when assertion failures are detected.",
      ]),
    )
  })

  test("dedupe returns existing id without appending duplicate", async () => {
    const setup = await setupSnapshot("dedupe", fixtureSnapshot())
    const first = JSON.parse(await renderRecordFailure(setup.worktree, { yes: true, json: true }))
    const second = JSON.parse(await renderRecordFailure(setup.worktree, { yes: true, json: true }))
    const records = await loadFailureRecords(setup.root)

    expect(records.records).toHaveLength(1)
    expect(second.deduped).toBe(true)
    expect(second.recordId).toBe(first.recordId)
  })

  test("overall cap drops low-value evidence first", async () => {
    const big = "lorem ipsum dolor sit amet ".repeat(1100)
    const setup = await setupSnapshot(
      "caps",
      fixtureSnapshot({
        contextGaps: Array.from({ length: 20 }, (_, i) => `gap ${i} ${big}`),
      }),
    )
    const out = JSON.parse(await renderRecordFailure(setup.worktree, { json: true }))

    expect(out.droppedEvidence[0]).toBe("git_status")
    expect(out.droppedEvidence[1]).toBe("diff_file_list")
    expect(out.droppedEvidence[2]).toBe("tool_timeline")
  })
})
