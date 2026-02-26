import fs from "node:fs/promises"
import type { FailureRecord } from "../model"
import { acquireWriteLock } from "../storage/lock"
import { storePathsFromRoot } from "./paths"

function parseDate(value: string) {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return 0
  return time
}

function safe(value: string | undefined) {
  if (!value) return "-"
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim() || "-"
}

export function renderSummary(records: Array<FailureRecord>) {
  const sorted = [...records].sort((a, b) => {
    const timeDiff = parseDate(b.createdAt) - parseDate(a.createdAt)
    if (timeDiff !== 0) return timeDiff
    return a.id.localeCompare(b.id)
  })

  const lines = [
    "# Failure Summary",
    "",
    `- Total records: ${sorted.length}`,
    "",
    "## Records",
    "",
    "| id | createdAt | sessionId | messageHash | toolFailureHash | evidenceCount |",
    "| --- | --- | --- | --- | --- | --- |",
    ...sorted.map((record) => {
      const evidenceCount = record.evidence?.length ?? 0
      return [
        `| ${safe(record.id)}`,
        `${safe(record.createdAt)}`,
        `${safe(record.sessionId)}`,
        `${safe(record.signature.messageHash)}`,
        `${safe(record.signature.toolFailureHash)}`,
        `${evidenceCount} |`,
      ].join(" | ")
    }),
  ]

  return `${lines.join("\n")}\n`
}

export async function writeSummary(root: string, records: Array<FailureRecord>) {
  const paths = storePathsFromRoot(root)
  const content = renderSummary(records)
  await fs.mkdir(paths.root, { recursive: true })
  const lock = await acquireWriteLock(paths.lock)

  try {
    await fs.writeFile(paths.summary, content, "utf8")
  } finally {
    await lock.release()
  }

  return {
    path: paths.summary,
    lockPath: paths.lock,
    content,
  }
}
