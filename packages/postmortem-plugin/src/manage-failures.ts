import fs from "node:fs/promises"
import { z } from "zod"
import type { FailureRecord } from "./model"
import { acquireWriteLock } from "./storage/lock"
import { resolvePostmortemRoot } from "./storage/paths"
import { loadFailureRecords, pruneFailureRecords } from "./store/failures"
import { storePathsFromRoot } from "./store/paths"
import { writeSummary } from "./store/summary"

const DAY_MS = 24 * 60 * 60 * 1000

const ActionSchema = z.enum(["list", "show", "forget", "delete", "prune", "purge"])

const IndexSchema = z.object({
  forgottenIds: z.array(z.string()).optional(),
})

export const ManageFailuresArgsSchema = z.object({
  action: ActionSchema.optional(),
  id: z.string().optional(),
  sessionId: z.string().optional(),
  json: z.boolean().optional(),
  yes: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  olderThanDays: z.number().int().nonnegative().optional(),
  keepLastN: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().nonnegative().optional(),
})

export type ManageFailuresArgs = z.infer<typeof ManageFailuresArgsSchema>

function parseDate(value: string) {
  const at = Date.parse(value)
  if (Number.isNaN(at)) return 0
  return at
}

function sortRecords(records: FailureRecord[]) {
  return [...records].sort((a, b) => {
    const diff = parseDate(b.createdAt) - parseDate(a.createdAt)
    if (diff !== 0) return diff
    return a.id.localeCompare(b.id)
  })
}

function safeEvidence(record: FailureRecord) {
  return (record.evidence ?? []).map((item) => ({
    type: item.type,
    hash: item.hash,
    byteCount: item.byteCount,
    tokenEstimate: item.tokenEstimate,
  }))
}

function listItem(record: FailureRecord, forgotten: Set<string>) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    sessionId: record.sessionId,
    messageHash: record.signature.messageHash,
    toolFailureHash: record.signature.toolFailureHash,
    evidenceCount: record.evidence?.length ?? 0,
    forgotten: forgotten.has(record.id),
  }
}

function showItem(record: FailureRecord, forgotten: Set<string>) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    projectId: record.projectId,
    sessionId: record.sessionId,
    signature: record.signature,
    evidenceCount: record.evidence?.length ?? 0,
    evidence: safeEvidence(record),
    forgotten: forgotten.has(record.id),
    hasRedactionReport: Boolean(record.redactionReport),
    hasSelectionTrace: Boolean(record.selectionTrace),
  }
}

function renderHuman(payload: {
  lines: string[]
  root: string
  undo: string
  indexPath: string
}) {
  return [...payload.lines, `storage root: ${payload.root}`, `undo: ${payload.undo}`, `index: ${payload.indexPath}`].join("\n")
}

async function loadIndex(indexPath: string) {
  const raw = await fs.readFile(indexPath, "utf8").catch(() => "")
  if (!raw) return { forgottenIds: [] as string[] }
  const parsed = await Promise.resolve()
    .then(() => JSON.parse(raw))
    .catch(() => ({}))
  const index = IndexSchema.parse(parsed)
  return {
    forgottenIds: Array.from(new Set(index.forgottenIds ?? [])),
  }
}

async function saveIndex(indexPath: string, ids: string[]) {
  const forgottenIds = Array.from(new Set(ids))
  await fs.writeFile(indexPath, `${JSON.stringify({ forgottenIds }, null, 2)}\n`, "utf8")
}

async function writeFailures(path: string, records: FailureRecord[]) {
  const lines = records.map((record) => JSON.stringify(record)).join("\n")
  const text = lines.length > 0 ? `${lines}\n` : ""
  await fs.writeFile(path, text, "utf8")
}

async function rewriteStore(root: string, writer: (state: { records: FailureRecord[]; forgottenIds: string[] }) => Promise<{ changed: boolean; payload: Record<string, unknown> }> | { changed: boolean; payload: Record<string, unknown> }) {
  const paths = storePathsFromRoot(root)
  await fs.mkdir(paths.root, { recursive: true })
  const lock = await acquireWriteLock(paths.lock)

  try {
    const loaded = await loadFailureRecords(root)
    const index = await loadIndex(paths.index)
    const base = {
      records: loaded.records,
      forgottenIds: index.forgottenIds,
    }
    const result = await writer(base)
    if (!result.changed) return result.payload

    const known = new Set(base.records.map((record) => record.id))
    const forgotten = base.forgottenIds.filter((id) => known.has(id))
    await writeFailures(paths.failures, base.records)
    await saveIndex(paths.index, forgotten)
    return {
      ...result.payload,
      changed: true,
    }
  } finally {
    await lock.release()
  }
}

async function refreshSummary(root: string) {
  const reloaded = await loadFailureRecords(root)
  await writeSummary(root, reloaded.records)
}

function errorPayload(message: string, root: string, indexPath: string) {
  return {
    ok: false,
    error: message,
    storageRoot: root,
    indexPath,
  }
}

export async function renderManageFailures(worktree: string, rawArgs: ManageFailuresArgs = {}) {
  const parsed = ManageFailuresArgsSchema.safeParse(rawArgs)
  const roots = await resolvePostmortemRoot(worktree)
  const root = roots.root
  const store = storePathsFromRoot(root)

  if (!parsed.success) {
    const payload = errorPayload(parsed.error.issues[0]?.message ?? "invalid arguments", root, store.index)
    if (rawArgs.json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      undo: `fix arguments and retry; to reset everything: rm -rf "${root}"`,
      indexPath: store.index,
    })
  }

  const args = parsed.data
  const action = args.action ?? "list"
  const json = Boolean(args.json)
  const undoReset = `rm -rf "${root}"`

  if ((action === "show" || action === "forget" || action === "delete") && !args.id) {
    const payload = errorPayload(`action ${action} requires id`, root, store.index)
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      undo: `retry with --id; full reset: ${undoReset}`,
      indexPath: store.index,
    })
  }

  if (action === "purge" && !args.yes) {
    const payload = errorPayload("purge requires yes=true", root, store.index)
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      undo: `purge not executed; to review first run list/show`,
      indexPath: store.index,
    })
  }

  if (action === "list") {
    const [loaded, index] = await Promise.all([loadFailureRecords(root), loadIndex(store.index)])
    const forgotten = new Set(index.forgottenIds)
    const cutoff = typeof args.olderThanDays === "number" ? Date.now() - args.olderThanDays * DAY_MS : undefined
    const records = sortRecords(loaded.records)
      .filter((record) => (args.sessionId ? record.sessionId === args.sessionId : true))
      .filter((record) => (typeof cutoff === "number" ? parseDate(record.createdAt) <= cutoff : true))
      .filter((record) => !forgotten.has(record.id))
      .map((record) => listItem(record, forgotten))
    const payload = {
      ok: true,
      action,
      storageRoot: root,
      indexPath: store.index,
      filters: {
        olderThanDays: args.olderThanDays,
        sessionId: args.sessionId,
      },
      count: records.length,
      records,
    }
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [
        `records: ${payload.count}`,
        ...records.slice(0, 50).map((record) => `${record.id} ${record.createdAt} session=${record.sessionId} evidence=${record.evidenceCount}`),
        ...(records.length > 50 ? ["...truncated..."] : []),
      ],
      root,
      undo: `listing is read-only; to clear storage: ${undoReset}`,
      indexPath: store.index,
    })
  }

  if (action === "show") {
    const [loaded, index] = await Promise.all([loadFailureRecords(root), loadIndex(store.index)])
    const forgotten = new Set(index.forgottenIds)
    const record = loaded.records.find((item) => item.id === args.id)
    if (!record) {
      const payload = errorPayload(`record not found: ${args.id}`, root, store.index)
      if (json) return JSON.stringify(payload)
      return renderHuman({
        lines: [payload.error],
        root,
        undo: `check ids with list; full reset: ${undoReset}`,
        indexPath: store.index,
      })
    }

    const safe = showItem(record, forgotten)
    const payload = {
      ok: true,
      action,
      storageRoot: root,
      indexPath: store.index,
      record: safe,
    }
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [
        `record: ${safe.id}`,
        `createdAt: ${safe.createdAt}`,
        `sessionId: ${safe.sessionId}`,
        `forgotten: ${safe.forgotten}`,
        `evidence: ${safe.evidenceCount}`,
      ],
      root,
      undo: `show is read-only; to remove record use delete/prune or clear all: ${undoReset}`,
      indexPath: store.index,
    })
  }

  if (action === "forget") {
    if (!args.id) {
      const payload = errorPayload(`action ${action} requires id`, root, store.index)
      if (json) return JSON.stringify(payload)
      return renderHuman({
        lines: [payload.error],
        root,
        undo: `retry with --id; full reset: ${undoReset}`,
        indexPath: store.index,
      })
    }
    const id = args.id
    const result = await rewriteStore(root, ({ records, forgottenIds }) => {
      const exists = records.some((record) => record.id === id)
      if (!exists) {
        return {
          changed: false,
          payload: errorPayload(`record not found: ${id}`, root, store.index),
        }
      }
      if (forgottenIds.includes(id)) {
        return {
          changed: false,
          payload: {
            ok: true,
            action,
            status: "already_forgotten",
            id,
            storageRoot: root,
            indexPath: store.index,
            changed: false,
          },
        }
      }
      forgottenIds.push(id)
      return {
        changed: true,
        payload: {
          ok: true,
          action,
          status: "forgotten",
          id,
          storageRoot: root,
          indexPath: store.index,
        },
      }
    })
    if ((result as { ok?: boolean }).ok === false) {
      if (json) return JSON.stringify(result)
      return renderHuman({
        lines: [(result as { error: string }).error],
        root,
        undo: `check ids with list; reset all: ${undoReset}`,
        indexPath: store.index,
      })
    }
    if ((result as { changed?: boolean }).changed) await refreshSummary(root)
    if (json) return JSON.stringify(result)
    return renderHuman({
      lines: [`forgotten: ${id}`],
      root,
      undo: `edit ${store.index} and remove ${id} from forgottenIds`,
      indexPath: store.index,
    })
  }

  if (action === "delete") {
    if (!args.id) {
      const payload = errorPayload(`action ${action} requires id`, root, store.index)
      if (json) return JSON.stringify(payload)
      return renderHuman({
        lines: [payload.error],
        root,
        undo: `retry with --id; full reset: ${undoReset}`,
        indexPath: store.index,
      })
    }
    const id = args.id
    const result = await rewriteStore(root, ({ records, forgottenIds }) => {
      const kept = records.filter((record) => record.id !== id)
      if (kept.length === records.length) {
        return {
          changed: false,
          payload: errorPayload(`record not found: ${id}`, root, store.index),
        }
      }
      records.splice(0, records.length, ...kept)
      const nextForgotten = forgottenIds.filter((item) => item !== id)
      forgottenIds.splice(0, forgottenIds.length, ...nextForgotten)
      return {
        changed: true,
        payload: {
          ok: true,
          action,
          status: "deleted",
          id,
          remaining: kept.length,
          storageRoot: root,
          indexPath: store.index,
        },
      }
    })
    if ((result as { ok?: boolean }).ok === false) {
      if (json) return JSON.stringify(result)
      return renderHuman({
        lines: [(result as { error: string }).error],
        root,
        undo: `check ids with list; reset all: ${undoReset}`,
        indexPath: store.index,
      })
    }
    if ((result as { changed?: boolean }).changed) await refreshSummary(root)
    if (json) return JSON.stringify(result)
    return renderHuman({
      lines: [`deleted: ${id}`],
      root,
      undo: `hard delete cannot be automatically undone; restore from backup or clear all: ${undoReset}`,
      indexPath: store.index,
    })
  }

  if (action === "prune") {
    const loaded = await loadFailureRecords(root)
    const pruned = pruneFailureRecords(loaded.records, {
      maxAgeDays: args.olderThanDays,
      keepLastN: args.keepLastN,
      maxBytes: args.maxBytes,
    })
    const droppedIds = pruned.dropped.map((record) => record.id)
    const payload = {
      ok: true,
      action,
      dryRun: Boolean(args.dryRun),
      storageRoot: root,
      indexPath: store.index,
      olderThanDays: args.olderThanDays,
      keepLastN: args.keepLastN,
      maxBytes: args.maxBytes,
      droppedCount: pruned.dropped.length,
      keptCount: pruned.kept.length,
      droppedIds,
    }

    if (!args.dryRun) {
      await rewriteStore(root, ({ records, forgottenIds }) => {
        records.splice(0, records.length, ...pruned.kept)
        const known = new Set(pruned.kept.map((record) => record.id))
        const nextForgotten = forgottenIds.filter((id) => known.has(id))
        forgottenIds.splice(0, forgottenIds.length, ...nextForgotten)
        return {
          changed: pruned.dropped.length > 0,
          payload,
        }
      })
      if (pruned.dropped.length > 0) await refreshSummary(root)
    }

    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [
        `prune dryRun=${payload.dryRun}`,
        `kept=${payload.keptCount} dropped=${payload.droppedCount}`,
        ...(payload.droppedIds.length > 0 ? [`dropped ids: ${payload.droppedIds.join(",")}`] : []),
      ],
      root,
      undo: payload.dryRun
        ? `dry run made no changes`
        : `prune is destructive; restore from backup or reset all: ${undoReset}`,
      indexPath: store.index,
    })
  }

  const lock = await acquireWriteLock(store.lock)
  try {
    await fs.rm(root, { recursive: true, force: true })
  } finally {
    await lock.release()
  }

  const payload = {
    ok: true,
    action,
    status: "purged",
    storageRoot: root,
  }
  if (json) return JSON.stringify(payload)
  return renderHuman({
    lines: ["purged all stored failure data for this project"],
    root,
    undo: `purge is irreversible without external backup`,
    indexPath: store.index,
  })
}
