import { type FailureRecord } from "./model";
import { loadFailureRecords } from "./store/failures";
import { resolvePostmortemRoot } from "./storage/paths";

type EvalArgs = { json?: boolean; window?: number };

function signatureKey(record: FailureRecord) {
  return record.signature.toolFailureHash ?? record.signature.messageHash;
}

function deterministicSort(records: FailureRecord[]) {
  return [...records].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (ta !== tb) return ta - tb; // oldest first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function renderEval(worktree: string, args: EvalArgs = {}) {
  const paths = await resolvePostmortemRoot(worktree);
  const loaded = await loadFailureRecords(paths.root);
  const records = deterministicSort(loaded.records as FailureRecord[]);
  const totalRecords = records.length;
  const sigs = records.map(signatureKey);

  const window = Math.max(1, Number(args.window ?? 10));

  // For each record i, check next `window` records for same signature key
  let repeatWithinWindowCount = 0;
  const repeatCounts: Record<string, number> = {};

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    // look ahead up to window records
    let repeated = false;
    for (let j = i + 1; j <= i + window && j < sigs.length; j++) {
      if (sigs[j] === s) {
        repeated = true;
        repeatCounts[s] = (repeatCounts[s] ?? 0) + 1;
      }
    }
    if (repeated) repeatWithinWindowCount++;
  }

  const uniqueSignatures = new Set(sigs).size;

  // Build repeatCountsBySignature as deterministic top list: sort by count desc, then signature asc
  const repeatCountsBySignature = Object.entries(repeatCounts)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([signature, count]) => ({ signature, count }));

  const payload = {
    totalRecords,
    uniqueSignatures,
    repeatRateWithinWindow: totalRecords === 0 ? 0 : repeatWithinWindowCount / totalRecords,
    repeatCountsBySignature,
  };

  if (args.json) return JSON.stringify(payload, null, 2);

  const lines: string[] = [];
  lines.push(`postmortem root: ${paths.root}`);
  lines.push(`total records: ${totalRecords}`);
  lines.push(`unique signatures: ${uniqueSignatures}`);
  lines.push(`repeat rate within window=${window}: ${payload.repeatRateWithinWindow}`);
  lines.push(`repeat counts by signature:`);
  for (const r of repeatCountsBySignature) lines.push(` - ${r.signature}: ${r.count}`);
  return lines.join("\n");
}

export default renderEval;
