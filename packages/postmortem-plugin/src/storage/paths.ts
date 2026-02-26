import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { projectId } from "./project"

export const PostmortemConfigSchema = z.object({
  storage: z.enum(["user", "repo"]).optional(),
  storeRaw: z.boolean().optional(),
})

export function postmortemConfigPath(worktree: string) {
  return path.join(path.resolve(worktree), ".opencode", "postmortem.json")
}

async function isSymlink(p: string) {
  const stat = await fs.lstat(p).catch(() => undefined)
  return stat?.isSymbolicLink() ?? false
}

async function symlinkError(p: string, operation: "read" | "write" | "append" | "lock", label: string) {
  if (!(await isSymlink(p))) return undefined
  return `refusing to ${operation} postmortem artifact because ${label} is a symlink: ${p}`
}

export async function assertSafeArtifactPath(
  p: string,
  operation: "read" | "write" | "append" | "lock",
  label: string,
) {
  const error = await symlinkError(p, operation, label)
  if (!error) return
  throw new Error(error)
}

export async function repoStorageSafety(worktree: string) {
  const root = path.resolve(worktree)
  const opencodeDir = path.join(root, ".opencode")
  if (await isSymlink(opencodeDir)) {
    return {
      safe: false,
      error: "repo-local postmortem storage is unsafe because .opencode is a symlink",
    }
  }

  const postmortemsDir = path.join(opencodeDir, "postmortems")
  if (await isSymlink(postmortemsDir)) {
    return {
      safe: false,
      error: "repo-local postmortem storage is unsafe because .opencode/postmortems is a symlink",
    }
  }

  const id = await projectId(worktree)
  const projectDir = path.join(postmortemsDir, id)
  if (await isSymlink(projectDir)) {
    return {
      safe: false,
      error: `repo-local postmortem storage is unsafe because .opencode/postmortems/${id} is a symlink`,
    }
  }

  const artifacts: Array<[string, string]> = [
    ["last-run.json", "last-run.json"],
    ["failures.jsonl", "failures.jsonl"],
    ["rules.json", "rules.json"],
    ["index.json", "index.json"],
    ["write.lock", "write.lock"],
  ]
  for (const [name, label] of artifacts) {
    const artifactPath = path.join(projectDir, name)
    if (await isSymlink(artifactPath)) {
      return {
        safe: false,
        error: `repo-local postmortem storage is unsafe because ${label} is a symlink at ${artifactPath}`,
      }
    }
  }

  return { safe: true }
}

export async function loadPostmortemConfig(worktree: string): Promise<z.infer<typeof PostmortemConfigSchema>> {
  const raw = await fs.readFile(postmortemConfigPath(worktree), "utf8").catch(() => "")
  if (!raw.trim()) return {}
  const parsed = await Promise.resolve()
    .then(() => JSON.parse(raw))
    .catch(() => ({}))
  const config = PostmortemConfigSchema.safeParse(parsed)
  if (!config.success) return {}
  return config.data
}

export async function savePostmortemConfig(worktree: string, config: z.infer<typeof PostmortemConfigSchema>) {
  const parsed = PostmortemConfigSchema.parse(config)
  const configPath = postmortemConfigPath(worktree)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  return {
    path: configPath,
    config: parsed,
  }
}

function baseDataDir() {
  const home = os.homedir()

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support")
  }

  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || process.env.APPDATA || path.join(home, "AppData", "Local")
  }

  return process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
}

export function globalPostmortemRoot() {
  return path.join(baseDataDir(), "opencode", "postmortems")
}

export async function postmortemPaths(worktree: string) {
  const resolvedWorktree = path.resolve(worktree)
  const id = await projectId(worktree)
  return {
    projectId: id,
    globalRoot: globalPostmortemRoot(),
    defaultRoot: path.join(globalPostmortemRoot(), id),
    localOverrideRoot: path.join(resolvedWorktree, ".opencode", "postmortems", id),
  }
}

export async function resolvePostmortemRoot(worktree: string): Promise<{
  projectId: string
  root: string
  defaultRoot: string
  localOverrideRoot: string
}> {
  const [paths, config] = await Promise.all([postmortemPaths(worktree), loadPostmortemConfig(worktree)])
  const repoSafe = config.storage === "repo" ? (await repoStorageSafety(worktree)).safe : false
  return {
    projectId: paths.projectId,
    defaultRoot: paths.defaultRoot,
    localOverrideRoot: paths.localOverrideRoot,
    root: repoSafe ? paths.localOverrideRoot : paths.defaultRoot,
  }
}
