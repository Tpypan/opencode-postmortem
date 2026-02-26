import { z } from "zod"

export const SNAPSHOT_SCHEMA_VERSION = 1

export const SnapshotToolStatus = z.enum(["pending", "running", "completed", "error"])

export const SnapshotDropSection = z.enum([
  "tools",
  "errors",
  "diff_files",
  "git_status",
  "context_gaps",
])

export const SnapshotTool = z.object({
  tool: z.string(),
  status: SnapshotToolStatus,
  durationMs: z.number().int().nonnegative().optional(),
})

export const SnapshotError = z.object({
  tool: z.string(),
  snippet: z.string(),
})

export const SnapshotDiffFile = z.object({
  file: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})

export const SnapshotDiff = z.object({
  totalFiles: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.array(SnapshotDiffFile),
})

export const SnapshotGitStatus = z.object({
  lines: z.array(z.string()),
  truncated: z.boolean(),
})

export const LastRunSnapshot = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  projectId: z.string(),
  sessionID: z.string(),
  capturedAt: z.string(),
  // Short stable hex signature derived from error/tool summaries for dedupe/relevance
  // Optional for backwards compatibility with older snapshots.
  errorSignature: z.string().regex(/^[0-9a-f]{16,32}$/).optional(),
  tools: z.array(SnapshotTool),
  errors: z.array(SnapshotError),
  diff: SnapshotDiff,
  gitStatus: SnapshotGitStatus.optional(),
  contextGaps: z.array(z.string()),
  meta: z.object({
    droppedDueToCaps: z.boolean(),
    droppedSections: z.array(SnapshotDropSection),
    source: z.object({
      messageCount: z.number().int().nonnegative(),
      toolCallCount: z.number().int().nonnegative(),
      diffFileCount: z.number().int().nonnegative(),
      gitRepo: z.boolean(),
    }),
  }),
})

export type SnapshotToolStatus = z.infer<typeof SnapshotToolStatus>
export type SnapshotDropSection = z.infer<typeof SnapshotDropSection>
export type SnapshotTool = z.infer<typeof SnapshotTool>
export type SnapshotError = z.infer<typeof SnapshotError>
export type SnapshotDiffFile = z.infer<typeof SnapshotDiffFile>
export type SnapshotDiff = z.infer<typeof SnapshotDiff>
export type SnapshotGitStatus = z.infer<typeof SnapshotGitStatus>
export type LastRunSnapshot = z.infer<typeof LastRunSnapshot>
