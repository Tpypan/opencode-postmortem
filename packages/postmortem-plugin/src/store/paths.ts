import path from "node:path"
import { resolvePostmortemRoot } from "../storage/paths"

export type FailureStorePaths = {
  root: string
  failures: string
  rules: string
  index: string
  summary: string
  lock: string
}

export function storePathsFromRoot(root: string): FailureStorePaths {
  return {
    root,
    failures: path.join(root, "failures.jsonl"),
    rules: path.join(root, "rules.json"),
    index: path.join(root, "index.json"),
    summary: path.join(root, "SUMMARY.md"),
    lock: path.join(root, "write.lock"),
  }
}

export async function storePaths(worktree: string) {
  const paths = await resolvePostmortemRoot(worktree)
  return storePathsFromRoot(paths.root)
}
