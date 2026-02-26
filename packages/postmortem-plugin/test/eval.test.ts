import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendFailureRecord } from "../src/store/failures";
import { postmortemPaths } from "../src/storage/paths";
import { FAILURE_RECORD_SCHEMA_VERSION, type FailureRecord } from "../src/model";

const dirs: string[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

function fixture(id: string, createdAt: string, sig: string): FailureRecord {
  return {
    schemaVersion: FAILURE_RECORD_SCHEMA_VERSION,
    id,
    projectId: "proj_test",
    createdAt,
    sessionId: "s",
    signature: { messageHash: sig },
  } as FailureRecord;
}

async function setup(records: FailureRecord[]) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `postmortem-eval-`));
  dirs.push(worktree);
  const paths = await postmortemPaths(worktree);
  roots.push(paths.defaultRoot);
  await fs.mkdir(paths.defaultRoot, { recursive: true });
  for (const r of records) await appendFailureRecord(paths.defaultRoot, r);
  return { worktree, root: paths.defaultRoot };
}

describe("postmortem eval", () => {
  test("deterministic repeat-rate with window=2 on 5-record fixture", async () => {
    // records in time order oldest->newest
    const records = [
      fixture("a", "2026-01-01T00:00:00.000Z", "sig1"),
      fixture("b", "2026-01-02T00:00:00.000Z", "sig2"),
      fixture("c", "2026-01-03T00:00:00.000Z", "sig1"),
      fixture("d", "2026-01-04T00:00:00.000Z", "sig3"),
      fixture("e", "2026-01-05T00:00:00.000Z", "sig1"),
    ];

    const s = await setup(records);
    const { renderEval } = await import("../src/eval");
    const out = JSON.parse(await renderEval(s.worktree, { json: true, window: 2 }));

    // totalRecords = 5
    expect(out.totalRecords).toBe(5);
    // uniqueSignatures = sig1, sig2, sig3 => 3
    expect(out.uniqueSignatures).toBe(3);
    // For window=2: examine each record's next 2 records
    // a(sig1) -> next b(sig2), c(sig1) => repeat -> counts[sig1]+=1
    // b(sig2) -> next c(sig1), d(sig3) => no
    // c(sig1) -> next d(sig3), e(sig1) => repeat -> counts[sig1]+=1
    // d(sig3) -> next e(sig1) => no
    // e(sig1) -> no next => no
    // repeatWithinWindowCount = 2 => rate = 2/5
    expect(out.repeatRateWithinWindow).toBeCloseTo(2 / 5);
    // repeatCountsBySignature should show sig1 count 2
    const entry = out.repeatCountsBySignature.find((r: { signature: string; count: number }) => r.signature === "sig1");
    expect(entry.count).toBe(2);
  });
});
