import { describe, expect, test } from "bun:test"
import { renderInspect } from "../src/inspect"
import fs from "node:fs/promises"
import path from "node:path"
import { postmortemPaths } from "../src/storage/paths"
import { LastRunSnapshot } from "../src/snapshot/model"

async function setupSnapshot(base: string, snapshot: unknown) {
  // Validate snapshot shape to avoid using `any` in tests and ensure
  // the written file matches the runtime schema. Keep behavior identical.
  const validated = LastRunSnapshot.parse(snapshot)
  const paths = await postmortemPaths(base)
  await fs.mkdir(paths.defaultRoot, { recursive: true })
  await fs.writeFile(path.join(paths.defaultRoot, "last-run.json"), JSON.stringify(validated, null, 2), "utf8")
  return paths.defaultRoot
}

describe("inspect", () => {
  test("missing file path case", async () => {
    const base = path.join(process.cwd(), `tmp-inspect-missing-${Math.random().toString(36).slice(2)}`)
    const out = await renderInspect(base)
    expect(out).toContain("No last-run snapshot found")
  })

  test("json mode returns valid JSON", async () => {
    const snapshot = {
      schemaVersion: 1,
      projectId: "p",
      sessionID: "s",
      capturedAt: new Date().toISOString(),
      tools: [],
      errors: [],
      diff: { totalFiles: 0, additions: 0, deletions: 0, files: [] },
      gitStatus: { lines: [], truncated: false },
      contextGaps: [],
      meta: { droppedDueToCaps: false, droppedSections: [], source: { messageCount: 0, toolCallCount: 0, diffFileCount: 0, gitRepo: false } }
    }
    const base = path.join(process.cwd(), `tmp-inspect-json-${Math.random().toString(36).slice(2)}`)
    await setupSnapshot(base, snapshot)
    const out = await renderInspect(base, { json: true })
    const parsed = JSON.parse(out)
    const validated = LastRunSnapshot.parse(parsed.snapshot)
    expect(parsed.root).toBeDefined()
    expect(validated.projectId).toBe("p")
  })

  test("default hides error snippets and file list", async () => {
    const snapshot = {
      schemaVersion: 1,
      projectId: "p",
      sessionID: "s",
      capturedAt: new Date().toISOString(),
      tools: [{ tool: "t", status: "completed" }],
      errors: [{ tool: "t", snippet: "secret code" }],
      diff: { totalFiles: 1, additions: 1, deletions: 0, files: [{ file: "a.txt", additions: 1, deletions: 0 }] },
      gitStatus: { lines: ["M a.txt"], truncated: false },
      contextGaps: [],
      meta: { droppedDueToCaps: false, droppedSections: [], source: { messageCount: 0, toolCallCount: 0, diffFileCount: 1, gitRepo: false } }
    }
    const base = path.join(process.cwd(), `tmp-inspect-default-${Math.random().toString(36).slice(2)}`)
    await setupSnapshot(base, snapshot)
    const out = await renderInspect(base)
    expect(out).toContain("errors: count=1")
    expect(out).not.toContain("secret code")
    expect(out).not.toContain("a.txt")
  })

  test("flags reveal files/errors/git", async () => {
    const snapshot = {
      schemaVersion: 1,
      projectId: "p",
      sessionID: "s",
      capturedAt: new Date().toISOString(),
      tools: [],
      errors: [{ tool: "t", snippet: "snippet" }],
      diff: { totalFiles: 1, additions: 1, deletions: 0, files: [{ file: "a.txt", additions: 1, deletions: 0 }] },
      gitStatus: { lines: ["M a.txt"], truncated: false },
      contextGaps: [],
      meta: { droppedDueToCaps: false, droppedSections: [], source: { messageCount: 0, toolCallCount: 0, diffFileCount: 1, gitRepo: true } }
    }
    const base = path.join(process.cwd(), `tmp-inspect-flags-${Math.random().toString(36).slice(2)}`)
    await setupSnapshot(base, snapshot)
    const out = await renderInspect(base, { files: true, errors: true, git: true })
    expect(out).toContain("a.txt")
    expect(out).toContain("snippet")
    expect(out).toContain("M a.txt")
  })
})
