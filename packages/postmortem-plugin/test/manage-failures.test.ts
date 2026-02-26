import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { renderManageFailures } from "../src/manage-failures"
import { FAILURE_RECORD_SCHEMA_VERSION, type FailureRecord } from "../src/model"
import { postmortemPaths } from "../src/storage/paths"
import { appendFailureRecord, loadFailureRecords } from "../src/store/failures"
import { storePathsFromRoot } from "../src/store/paths"

const dirs: string[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function fixture(id: string, createdAt: string, sessionId = "session_a"): FailureRecord {
  return {
    schemaVersion: FAILURE_RECORD_SCHEMA_VERSION,
    id,
    projectId: "proj_test",
    createdAt,
    sessionId,
    signature: {
      messageHash: `msg_${id}`,
      toolFailureHash: `tool_${id}`,
    },
    evidence: [
      {
        type: "error",
        redactedText: "API_KEY=[REDACTED]",
        hash: `hash_${id}`,
        byteCount: 18,
        tokenEstimate: 5,
      },
    ],
  }
}

async function setup(name: string, records: FailureRecord[]) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `postmortem-manage-${name}-`))
  dirs.push(worktree)
  const paths = await postmortemPaths(worktree)
  roots.push(paths.defaultRoot)
  await fs.mkdir(paths.defaultRoot, { recursive: true })
  for (const record of records) {
    await appendFailureRecord(paths.defaultRoot, record)
  }
  return {
    worktree,
    root: paths.defaultRoot,
  }
}

describe("manage-failures", () => {
  test("list and show are safe by default and support filters", async () => {
    const now = new Date().toISOString()
    const setupData = await setup("list", [
      fixture("old", "2020-01-01T00:00:00.000Z", "session_old"),
      fixture("new", now, "session_new"),
    ])

    const listOlder = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "list",
        olderThanDays: 30,
        json: true,
      }),
    )
    expect(listOlder.records.map((record: { id: string }) => record.id)).toEqual(["old"])

    const listSession = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "list",
        sessionId: "session_new",
        json: true,
      }),
    )
    expect(listSession.records.map((record: { id: string }) => record.id)).toEqual(["new"])

    const show = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "show",
        id: "old",
        json: true,
      }),
    )

    expect(show.record.evidence[0].redactedText).toBeUndefined()
    expect(JSON.stringify(show)).not.toContain("API_KEY")
  })

  test("forget hides record from list and updates index state", async () => {
    const setupData = await setup("forget", [fixture("a", "2026-02-01T00:00:00.000Z")])
    const paths = storePathsFromRoot(setupData.root)

    const out = await renderManageFailures(setupData.worktree, {
      action: "forget",
      id: "a",
      json: true,
    })
    const payload = JSON.parse(out)
    const list = JSON.parse(await renderManageFailures(setupData.worktree, { action: "list", json: true }))
    const index = JSON.parse(await fs.readFile(paths.index, "utf8"))

    expect(payload.status).toBe("forgotten")
    expect(list.count).toBe(0)
    expect(index.forgottenIds).toEqual(["a"])
    const summary = await fs.readFile(paths.summary, "utf8")
    expect(summary).toContain("- Total records: 1")
  })

  test("delete removes record and prune dryRun does not mutate", async () => {
    const setupData = await setup("delete-prune", [
      fixture("a", "2026-02-28T00:00:00.000Z"),
      fixture("b", "2026-02-27T00:00:00.000Z"),
      fixture("c", "2026-02-26T00:00:00.000Z"),
    ])
    const paths = storePathsFromRoot(setupData.root)

    const dry = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "prune",
        keepLastN: 2,
        dryRun: true,
        json: true,
      }),
    )
    expect(dry.droppedIds).toEqual(["c"])
    const afterDry = await loadFailureRecords(setupData.root)
    expect(afterDry.records).toHaveLength(3)

    const deleted = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "delete",
        id: "b",
        json: true,
      }),
    )
    const reloaded = await loadFailureRecords(setupData.root)
    const summary = await fs.readFile(paths.summary, "utf8")

    expect(deleted.status).toBe("deleted")
    expect(reloaded.records.map((record) => record.id)).toEqual(["a", "c"])
    expect(summary).toContain("- Total records: 2")
  })

  test("prune by maxBytes drops oldest deterministically", async () => {
    const setupData = await setup("maxbytes", [
      // newest
      fixture("a", "2026-02-28T00:00:00.000Z"),
      fixture("b", "2026-02-27T00:00:00.000Z"),
      // oldest
      fixture("c", "2026-02-26T00:00:00.000Z"),
    ])

    // compute sizes the same way prune uses (JSONL line bytes)
    const records = (await loadFailureRecords(setupData.root)).records
    const sizes = records.map((r) => Buffer.byteLength(`${JSON.stringify(r)}\n`, "utf8"))
    // keep newest two (a,b): set maxBytes to exactly sum of their sizes
    const maxBytes = sizes[0] + sizes[1]

    const dry = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "prune",
        maxBytes,
        dryRun: true,
        json: true,
      }),
    )
    expect(dry.droppedIds).toEqual(["c"])
  })

  test("prune combines olderThanDays and maxBytes deterministically", async () => {
    const setupData = await setup("combined", [
      fixture("a", "2099-01-03T00:00:00.000Z"),
      fixture("b", "2099-01-02T00:00:00.000Z"),
      fixture("c", "2099-01-01T00:00:00.000Z"),
      fixture("d", "2000-01-01T00:00:00.000Z"),
    ])

    const records = (await loadFailureRecords(setupData.root)).records
    const byId = new Map(
      records.map((record) => [record.id, Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8")]),
    )
    const maxBytes = (byId.get("a") ?? 0) + (byId.get("b") ?? 0)

    const dry = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "prune",
        olderThanDays: 30,
        maxBytes,
        dryRun: true,
        json: true,
      }),
    )
    expect(dry.droppedIds).toEqual(["c", "d"])

    const afterDry = await loadFailureRecords(setupData.root)
    expect(afterDry.records.map((record) => record.id)).toEqual(["a", "b", "c", "d"])

    const applied = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "prune",
        olderThanDays: 30,
        maxBytes,
        json: true,
      }),
    )
    expect(applied.droppedIds).toEqual(["c", "d"])

    const afterApply = await loadFailureRecords(setupData.root)
    expect(afterApply.records.map((record) => record.id)).toEqual(["a", "b"])
  })

  test("purge requires yes and removes project data when confirmed", async () => {
    const setupData = await setup("purge", [fixture("a", "2026-02-01T00:00:00.000Z")])

    const denied = JSON.parse(await renderManageFailures(setupData.worktree, { action: "purge", json: true }))
    expect(denied.ok).toBe(false)

    const allowed = JSON.parse(
      await renderManageFailures(setupData.worktree, {
        action: "purge",
        yes: true,
        json: true,
      }),
    )
    expect(allowed.status).toBe("purged")
    await expect(fs.stat(setupData.root)).rejects.toBeTruthy()
  })
})
