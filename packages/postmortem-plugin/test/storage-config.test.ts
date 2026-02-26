import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LastRunSnapshot } from "../src/snapshot/model"
import { writeLastRunSnapshot } from "../src/snapshot/write"
import {
  postmortemConfigPath,
  postmortemPaths,
  resolvePostmortemRoot,
} from "../src/storage/paths"

const dirs: string[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function fixtureSnapshot() {
  return LastRunSnapshot.parse({
    schemaVersion: 1,
    projectId: "proj_test",
    sessionID: "session_test",
    capturedAt: "2026-02-26T00:00:00.000Z",
    tools: [],
    errors: [],
    diff: {
      totalFiles: 0,
      additions: 0,
      deletions: 0,
      files: [],
    },
    contextGaps: [],
    meta: {
      droppedDueToCaps: false,
      droppedSections: [],
      source: {
        messageCount: 0,
        toolCallCount: 0,
        diffFileCount: 0,
        gitRepo: false,
      },
    },
  })
}

describe("postmortem storage config", () => {
  test("uses repo-local root for snapshot writes when storage=repo", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-storage-repo-"))
    dirs.push(worktree)

    const paths = await postmortemPaths(worktree)
    roots.push(paths.defaultRoot)

    await fs.mkdir(path.dirname(postmortemConfigPath(worktree)), { recursive: true })
    await fs.writeFile(postmortemConfigPath(worktree), '{"storage":"repo"}\n', "utf8")

    const write = await writeLastRunSnapshot({
      worktree,
      snapshot: fixtureSnapshot(),
    })

    const resolved = await resolvePostmortemRoot(worktree)
    const expectedPrefix = path.join(worktree, ".opencode", "postmortems", paths.projectId)
    expect(resolved.root).toBe(paths.localOverrideRoot)
    expect(write.root).toBe(paths.localOverrideRoot)
    expect(write.jsonPath.startsWith(expectedPrefix)).toBe(true)
  })
})
