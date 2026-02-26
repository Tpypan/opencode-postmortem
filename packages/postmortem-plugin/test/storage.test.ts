import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireWriteLock, LockBusyError } from "../src/storage/lock"
import { postmortemPaths } from "../src/storage/paths"
import { projectId } from "../src/storage/project"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("storage identity and lock", () => {
  test("projectId is deterministic from canonical path", async () => {
    const worktree = await temp("postmortem-worktree-")
    const nested = path.join(worktree, ".", "sub", "..")

    const first = await projectId(worktree)
    const second = await projectId(nested)
    const paths = await postmortemPaths(worktree)

    expect(first).toBe(second)
    expect(paths.projectId).toBe(first)
    expect(paths.defaultRoot).not.toContain(worktree)
    expect(paths.localOverrideRoot).toContain(path.join(".opencode", "postmortems"))
  })

  test("second acquisition is blocked while lock is held", async () => {
    const dir = await temp("postmortem-lock-")
    const lockPath = path.join(dir, "write.lock")

    const lock = await acquireWriteLock(lockPath)

    await expect(acquireWriteLock(lockPath)).rejects.toBeInstanceOf(LockBusyError)

    await lock.release()
  })

  test("stale lock is cleared and reacquired", async () => {
    const dir = await temp("postmortem-stale-lock-")
    const lockPath = path.join(dir, "write.lock")
    const now = Date.now()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 424242,
        createdAt: new Date(now - 300_000).toISOString(),
      }),
      "utf8",
    )

    const lock = await acquireWriteLock(lockPath, { staleTtlMs: 120_000, now: () => now })
    const content = await fs.readFile(lockPath, "utf8")
    const parsed = JSON.parse(content) as { pid: number; createdAt: string }

    expect(parsed.pid).toBe(process.pid)
    expect(Date.parse(parsed.createdAt)).toBe(now)

    await lock.release()
  })
})
