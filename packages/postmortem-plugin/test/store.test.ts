import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FAILURE_RECORD_SCHEMA_VERSION, type FailureRecord } from "../src/model"
import { loadFailureRecords } from "../src/store/failures"
import { pruneFailureRecords } from "../src/store/failures"
import { storePathsFromRoot } from "../src/store/paths"
import { renderSummary, writeSummary } from "../src/store/summary"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function fixture(id: string, createdAt: string): FailureRecord {
  return {
    schemaVersion: FAILURE_RECORD_SCHEMA_VERSION,
    id,
    projectId: "proj_1",
    createdAt,
    sessionId: `session_${id}`,
    signature: {
      messageHash: `message_${id}`,
      toolFailureHash: `tool_${id}`,
    },
    evidence: [
      {
        type: "error",
        redactedText: "redacted",
        hash: `hash_${id}`,
        byteCount: 8,
        tokenEstimate: 2,
      },
    ],
  }
}

describe("failure store", () => {
  test("missing failures store returns empty result", async () => {
    const root = await temp("postmortem-store-empty-")
    const result = await loadFailureRecords(root)

    expect(result.records).toEqual([])
    expect(result.skipped).toBe(0)
    expect(result.warnings).toEqual([])
  })

  test("salvage loader keeps valid lines and reports corrupted lines", async () => {
    const root = await temp("postmortem-store-salvage-")
    const paths = storePathsFromRoot(root)
    const valid = fixture("a", "2026-02-26T00:00:00.000Z")

    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(
      paths.failures,
      `${JSON.stringify(valid)}\n{"schemaVersion":1,"id":"broken"\n`,
      "utf8",
    )

    const result = await loadFailureRecords(root)

    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.id).toBe("a")
    expect(result.skipped).toBe(1)
    expect(result.warnings).toEqual([
      {
        line: 2,
        message: "skipped corrupted or invalid failure record",
      },
    ])
  })

  test("summary generation is deterministic", async () => {
    const root = await temp("postmortem-store-summary-")
    const paths = storePathsFromRoot(root)
    const first = fixture("alpha", "2026-02-27T00:00:00.000Z")
    const second = fixture("beta", "2026-02-26T00:00:00.000Z")
    const input = [second, first]

    const renderedA = renderSummary(input)
    const renderedB = renderSummary(input)
    expect(renderedA).toBe(renderedB)

    await writeSummary(root, input)
    const firstWrite = await fs.readFile(paths.summary, "utf8")
    await writeSummary(root, input)
    const secondWrite = await fs.readFile(paths.summary, "utf8")

    expect(firstWrite).toBe(secondWrite)
    expect(firstWrite).toContain("- Total records: 2")
    expect(firstWrite.indexOf("alpha")).toBeLessThan(firstWrite.indexOf("beta"))
    expect(firstWrite).not.toContain("redacted")
  })

  test("pruneFailureRecords applies age, count and size limits deterministically", () => {
    const now = "2026-03-01T00:00:00.000Z"
    const a = fixture("a", "2026-02-28T00:00:00.000Z")
    const b = fixture("b", "2026-02-27T00:00:00.000Z")
    const c = fixture("c", "2026-02-26T00:00:00.000Z")
    const d = fixture("d", "2026-02-25T00:00:00.000Z")

    // newest first: a, b, c, d
    const all = [c, a, d, b]

    // age: maxAgeDays=3 from 2026-03-01 -> keep since 2026-02-26T00:00:00Z and newer -> a,b,c kept, d dropped
    const { kept: keptByAge, dropped: droppedByAge } = pruneFailureRecords(all, { nowIso: now, maxAgeDays: 3 })
    expect(keptByAge.map((r) => r.id)).toEqual(["a", "b", "c"])
    expect(droppedByAge.map((r) => r.id)).toEqual(["d"])

    // count: keepLastN=2 -> keep newest two (a,b), drop rest
    const { kept: keptByCount, dropped: droppedByCount } = pruneFailureRecords(all, { nowIso: now, keepLastN: 2 })
    expect(keptByCount.map((r) => r.id)).toEqual(["a", "b"])
    expect(droppedByCount.map((r) => r.id)).toEqual(["c", "d"])

    // size: very small maxBytes to only fit two records
    const smallMax = Buffer.byteLength(`${JSON.stringify(a)}\n`, "utf8") * 2
    const { kept: keptBySize, dropped: droppedBySize } = pruneFailureRecords(all, { nowIso: now, maxBytes: smallMax })
    expect(keptBySize.length).toBeLessThanOrEqual(2)
    // deterministic kept are newest first
    expect(keptBySize.map((r) => r.id)).toEqual(["a", "b"].slice(0, keptBySize.length))
    expect(droppedBySize.map((r) => r.id)).toEqual(["c", "d"].slice(0, droppedBySize.length))
  })
})
