import fs from "node:fs/promises"
import path from "node:path"
import { assertSafeArtifactPath } from "./paths"

export const DEFAULT_LOCK_STALE_TTL_MS = 120_000

export class LockBusyError extends Error {
  constructor(readonly lockPath: string) {
    super(`lock already held: ${lockPath}`)
    this.name = "LockBusyError"
  }
}

type LockData = {
  pid: number
  createdAt: string
}

function stale(data: LockData, now: number, ttlMs: number) {
  const createdAt = Date.parse(data.createdAt)
  if (Number.isNaN(createdAt)) return true
  return now - createdAt > ttlMs
}

async function read(lockPath: string) {
  await assertSafeArtifactPath(lockPath, "read", "write.lock")
  const text = await fs.readFile(lockPath, "utf8")
  return JSON.parse(text) as LockData
}

async function readOptional(lockPath: string) {
  return read(lockPath).catch((error) => {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") return null
    throw error
  })
}

async function claim(lockPath: string, now: number) {
  await assertSafeArtifactPath(lockPath, "lock", "write.lock")
  const data = {
    pid: process.pid,
    createdAt: new Date(now).toISOString(),
  }
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  await fs.writeFile(lockPath, JSON.stringify(data), { flag: "wx" })
  return data
}

export async function acquireWriteLock(
  lockPath: string,
  options: {
    staleTtlMs?: number
    now?: () => number
  } = {},
) {
  const staleTtlMs = options.staleTtlMs ?? DEFAULT_LOCK_STALE_TTL_MS
  const now = options.now ?? Date.now

  try {
    const data = await claim(lockPath, now())
    return {
      data,
      path: lockPath,
      release: async () => {
        const current = await readOptional(lockPath)
        if (!current) return
        if (current.pid !== data.pid || current.createdAt !== data.createdAt) return
        await fs.rm(lockPath, { force: true })
      },
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== "EEXIST") throw err
  }

  const current = await readOptional(lockPath)
  if (!current || !stale(current, now(), staleTtlMs)) {
    throw new LockBusyError(lockPath)
  }

  await fs.rm(lockPath, { force: true })

  try {
    const data = await claim(lockPath, now())
    return {
      data,
      path: lockPath,
      release: async () => {
        const latest = await readOptional(lockPath)
        if (!latest) return
        if (latest.pid !== data.pid || latest.createdAt !== data.createdAt) return
        await fs.rm(lockPath, { force: true })
      },
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === "EEXIST") throw new LockBusyError(lockPath)
    throw err
  }
}
