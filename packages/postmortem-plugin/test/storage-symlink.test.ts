import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireWriteLock } from "../src/storage/lock"
import {
  postmortemConfigPath,
  postmortemPaths,
  repoStorageSafety,
  resolvePostmortemRoot,
} from "../src/storage/paths"
import { loadFailureRecords } from "../src/store/failures"

const dirs: string[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function temp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("repo-local symlink hardening", () => {
  test("repo storage is unsafe when project directory is a symlink", async () => {
    const worktree = await temp("postmortem-symlink-worktree-")
    const outside = await temp("postmortem-symlink-outside-")
    const paths = await postmortemPaths(worktree)
    roots.push(paths.defaultRoot)
    await fs.mkdir(path.join(worktree, ".opencode", "postmortems"), { recursive: true })
    await fs.symlink(outside, path.join(worktree, ".opencode", "postmortems", paths.projectId), "dir")
    await fs.writeFile(postmortemConfigPath(worktree), '{"storage":"repo"}\n', "utf8")

    const safety = await repoStorageSafety(worktree)
    const resolved = await resolvePostmortemRoot(worktree)

    expect(safety.safe).toBe(false)
    expect(safety.error).toContain(paths.projectId)
    expect(resolved.root).toBe(paths.defaultRoot)
  })

  test("refuses reading failures when failures.jsonl is a symlink", async () => {
    const root = await temp("postmortem-symlink-failures-")
    const outsideFile = path.join(await temp("postmortem-symlink-failures-outside-"), "outside.jsonl")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(outsideFile, "[]\n", "utf8")
    await fs.symlink(outsideFile, path.join(root, "failures.jsonl"), "file")

    await expect(loadFailureRecords(root)).rejects.toThrow(
      "refusing to read postmortem artifact because failures.jsonl is a symlink",
    )
  })

  test("refuses acquiring lock when write.lock is a symlink", async () => {
    const root = await temp("postmortem-symlink-lock-")
    const outsideFile = path.join(await temp("postmortem-symlink-lock-outside-"), "outside.lock")
    const lockPath = path.join(root, "write.lock")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(outsideFile, "{}\n", "utf8")
    await fs.symlink(outsideFile, lockPath, "file")

    await expect(acquireWriteLock(lockPath)).rejects.toThrow(
      "refusing to lock postmortem artifact because write.lock is a symlink",
    )
  })
})
