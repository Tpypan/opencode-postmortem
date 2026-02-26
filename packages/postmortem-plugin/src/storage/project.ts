import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const PROJECT_HASH_LENGTH = 24

export async function canonicalWorktree(worktree: string) {
  const resolved = path.resolve(worktree)
  const canonical = await fs.realpath(resolved).catch(() => resolved)
  return process.platform === "win32" ? canonical.toLowerCase() : canonical
}

export async function projectId(worktree: string) {
  const canonical = await canonicalWorktree(worktree)
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, PROJECT_HASH_LENGTH)
}
