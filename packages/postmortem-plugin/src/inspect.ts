import fs from "node:fs/promises"
import path from "node:path"
import { LastRunSnapshot, type LastRunSnapshot as LastRunSnapshotType } from "./snapshot/model"
import { resolvePostmortemRoot } from "./storage/paths"

export type InspectArgs = {
  json?: boolean
  files?: boolean
  git?: boolean
  errors?: boolean
}

function safeSummary(snapshot: LastRunSnapshotType, flags: InspectArgs) {
  const tools = snapshot.tools.map((t) => ({ tool: t.tool, status: t.status, durationMs: t.durationMs }))
  const diff = {
    totalFiles: snapshot.diff.totalFiles,
    additions: snapshot.diff.additions,
    deletions: snapshot.diff.deletions,
    files: flags.files ? snapshot.diff.files : undefined,
  }

  const errors = flags.errors ? snapshot.errors : snapshot.errors.map((e) => ({ tool: e.tool }))

  const gitStatus = flags.git ? snapshot.gitStatus : snapshot.gitStatus ? { lines: undefined, truncated: snapshot.gitStatus.truncated } : undefined

  return {
    projectId: snapshot.projectId,
    sessionID: snapshot.sessionID,
    capturedAt: snapshot.capturedAt,
    tools,
    diff,
    errors: { count: snapshot.errors.length, details: errors },
    gitStatus,
    contextGaps: snapshot.contextGaps,
    meta: snapshot.meta,
  }
}

export async function renderInspect(worktree: string, args: InspectArgs = {}) {
  const paths = await resolvePostmortemRoot(worktree)
  const jsonPath = path.join(paths.root, "last-run.json")
  try {
    const raw = await fs.readFile(jsonPath, "utf8")
    // measure size before parsing
    const size = Buffer.byteLength(raw, "utf8")
    const tokens = Math.ceil(size / 4)
    const parsed = JSON.parse(raw)
    const snapshot = LastRunSnapshot.parse(parsed)

    if (args.json) return JSON.stringify({ root: paths.root, snapshot }, null, 2)

    const out = safeSummary(snapshot, args)
    const lines: string[] = []
    lines.push(`postmortem root: ${paths.root}`)
    lines.push(`project: ${snapshot.projectId} session: ${snapshot.sessionID} capturedAt: ${snapshot.capturedAt}`)
    lines.push(`tools:`)
    for (const t of out.tools) lines.push(` - ${t.tool} ${t.status}${t.durationMs ? ` ${t.durationMs}ms` : ""}`)
    lines.push(`diff: files=${out.diff.totalFiles} +${out.diff.additions} -${out.diff.deletions}`)
    if (args.files && out.diff.files) {
      lines.push(" diff files:")
      for (const f of out.diff.files) lines.push(`  - ${f.file} +${f.additions} -${f.deletions}`)
    }
    if (args.git && out.gitStatus && out.gitStatus.lines) {
      lines.push("git status:")
      for (const l of out.gitStatus.lines) lines.push(` - ${l}`)
    }
    lines.push(`errors: count=${out.errors.count} tools=${[...new Set(snapshot.errors.map((e) => e.tool))].join(",")}`)
    if (args.errors) {
      for (const e of snapshot.errors) lines.push(` - ${e.tool}: ${e.snippet}`)
    }
    lines.push(`context gaps: ${snapshot.contextGaps.length}`)
    lines.push(`meta: droppedDueToCaps=${snapshot.meta.droppedDueToCaps} droppedSections=${snapshot.meta.droppedSections.join(",")}`)
    lines.push(`bloat: snapshotBytes=${size} tokenEstimate=${tokens}`)
    lines.push("hint: to delete these files, remove the directory above")

    return lines.join("\n")
  } catch {
    return `No last-run snapshot found at ${path.join(paths.root, "last-run.json")}\nRun an OpenCode session or ensure the postmortem plugin wrote a snapshot.`
  }
}
