import fs from "node:fs/promises"
import path from "node:path"
import { acquireWriteLock } from "../storage/lock"
import { assertSafeArtifactPath, resolvePostmortemRoot } from "../storage/paths"
import { LastRunSnapshot, type LastRunSnapshot as LastRunSnapshotType } from "./model"

export type WriteLastRunSnapshotInput = {
  worktree: string
  snapshot: LastRunSnapshotType
  rawSnapshot?: LastRunSnapshotType
  markdown?: string
}

export async function writeLastRunSnapshot(input: WriteLastRunSnapshotInput) {
  const paths = await resolvePostmortemRoot(input.worktree)
  const lockPath = path.join(paths.root, "write.lock")
  const jsonPath = path.join(paths.root, "last-run.json")
  const rawJsonPath = path.join(paths.root, "last-run.raw.json")
  const markdownPath = path.join(paths.root, "last-run.md")
  const parsed = LastRunSnapshot.parse(input.snapshot)
  const rawParsed = input.rawSnapshot ? LastRunSnapshot.parse(input.rawSnapshot) : undefined

  await fs.mkdir(paths.root, { recursive: true })
  await assertSafeArtifactPath(jsonPath, "write", "last-run.json")
  if (rawParsed) {
    await assertSafeArtifactPath(rawJsonPath, "write", "last-run.raw.json")
  }
  if (input.markdown) {
    await assertSafeArtifactPath(markdownPath, "write", "last-run.md")
  }
  const lock = await acquireWriteLock(lockPath)

  try {
    await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), "utf8")
    if (rawParsed) {
      await fs.writeFile(rawJsonPath, JSON.stringify(rawParsed, null, 2), "utf8")
    }
    if (input.markdown) {
      await fs.writeFile(markdownPath, input.markdown, "utf8")
    }
  } finally {
    await lock.release()
  }

  return {
    root: paths.root,
    jsonPath,
    rawJsonPath: rawParsed ? rawJsonPath : undefined,
    markdownPath: input.markdown ? markdownPath : undefined,
  }
}
