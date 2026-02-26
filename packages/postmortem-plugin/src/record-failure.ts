import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildDeterministicAnalysis } from "./analysis";
import {
	type EvidenceItem,
	FAILURE_RECORD_SCHEMA_VERSION,
	type FailureRecord,
} from "./model";
import {
	DEFAULT_EVIDENCE_ITEM_BYTES,
	DEFAULT_FAILURE_TOTAL_BYTES,
	type PatternCount,
	redact,
} from "./redaction";
import { LastRunSnapshot } from "./snapshot/model";
import { resolvePostmortemRoot } from "./storage/paths";
import { appendFailureRecord, loadFailureRecords } from "./store/failures";
import { storePathsFromRoot } from "./store/paths";
import { writeSummary } from "./store/summary";

const HASH_SLICE = 24;
const MAX_DIFF_FILES = 80;
const MAX_GIT_LINES = 120;
const MAX_REASON_BYTES = 1024;
const MAX_TAGS = 20;
const MAX_TAG_BYTES = 64;

export type RecordFailureArgs = {
	yes?: boolean;
	json?: boolean;
	reason?: string;
	tags?: string[];
};

type EvidenceBuild = {
	key: string;
	item: EvidenceItem;
	redactions: number;
	patterns: PatternCount;
	capped: boolean;
};

function bytes(text: string) {
	return Buffer.byteLength(text, "utf8");
}

function hash(text: string) {
	return crypto
		.createHash("sha256")
		.update(text, "utf8")
		.digest("hex")
		.slice(0, HASH_SLICE);
}

function tokens(byteCount: number) {
	return Math.ceil(byteCount / 4);
}

function toEvidence(type: EvidenceItem["type"], text: string, key: string) {
	const out = redact(text, { maxBytes: DEFAULT_EVIDENCE_ITEM_BYTES });
	const trimmed = out.text.trim();
	if (!trimmed) return undefined;
	const byteCount = bytes(trimmed);
	return {
		key,
		item: {
			type,
			redactedText: trimmed,
			hash: hash(trimmed),
			byteCount,
			tokenEstimate: tokens(byteCount),
		} satisfies EvidenceItem,
		redactions: out.report.totalReplacements,
		patterns: out.report.patterns,
		capped: out.report.droppedDueToCaps,
	} satisfies EvidenceBuild;
}

function mergePatternCounts(items: EvidenceBuild[]) {
	return items.reduce((all, item) => {
		Object.entries(item.patterns).forEach(([k, v]) => {
			all[k] = (all[k] ?? 0) + v;
		});
		return all;
	}, {} as PatternCount);
}

function buildToolSummary(snapshot: LastRunSnapshot) {
	if (snapshot.tools.length === 0) return "tool timeline: none";
	return [
		"tool timeline:",
		...snapshot.tools.map(
			(tool) =>
				`- ${tool.tool}: ${tool.status}${tool.durationMs !== undefined ? ` (${tool.durationMs}ms)` : ""}`,
		),
	].join("\n");
}

function buildErrorSummary(snapshot: LastRunSnapshot) {
	if (snapshot.errors.length === 0) return "error summary: none";
	return [
		"error summary:",
		...snapshot.errors.map((error) => `- ${error.tool}: ${error.snippet}`),
	].join("\n");
}

function buildDiffSummary(snapshot: LastRunSnapshot, includeFiles: boolean) {
	const lines = [
		"diff summary:",
		`- totals: files=${snapshot.diff.totalFiles} additions=${snapshot.diff.additions} deletions=${snapshot.diff.deletions}`,
	];
	if (!includeFiles || snapshot.diff.files.length === 0)
		return lines.join("\n");
	return [
		...lines,
		"- file changes:",
		...snapshot.diff.files
			.slice(0, MAX_DIFF_FILES)
			.map(
				(file) => `  - ${file.file} (+${file.additions}/-${file.deletions})`,
			),
	].join("\n");
}

function buildGitStatus(snapshot: LastRunSnapshot) {
	if (!snapshot.gitStatus || snapshot.gitStatus.lines.length === 0)
		return undefined;
	return [
		"git status:",
		...snapshot.gitStatus.lines
			.slice(0, MAX_GIT_LINES)
			.map((line) => `- ${line}`),
		...(snapshot.gitStatus.truncated ? ["- ...truncated..."] : []),
	].join("\n");
}

function buildMessageHash(snapshot: LastRunSnapshot) {
	if (snapshot.errorSignature) return snapshot.errorSignature;
	return hash(
		JSON.stringify({
			tools: snapshot.tools.map((item) => `${item.tool}:${item.status}`),
			errors: snapshot.errors.map((item) => `${item.tool}:${item.snippet}`),
		}),
	);
}

function buildToolFailureHash(snapshot: LastRunSnapshot) {
	const failed = snapshot.tools
		.filter((tool) => tool.status === "error")
		.map((tool) => tool.tool);
	if (failed.length === 0) return undefined;
	return hash(JSON.stringify(failed));
}

function stableSignatureText(record: FailureRecord) {
	return `${record.signature.messageHash}|${record.signature.toolFailureHash ?? ""}`;
}

function matchesDedupe(a: FailureRecord, b: FailureRecord) {
	return (
		a.projectId === b.projectId &&
		a.sessionId === b.sessionId &&
		stableSignatureText(a) === stableSignatureText(b)
	);
}

function sanitizeReason(reason?: string) {
	if (!reason) return undefined;
	const out = redact(reason, { maxBytes: MAX_REASON_BYTES }).text.trim();
	if (!out) return undefined;
	return out;
}

function sanitizeTags(tags?: string[]) {
	if (!tags || tags.length === 0) return undefined;
	const out = Array.from(
		new Set(
			tags
				.map((tag) => redact(tag, { maxBytes: MAX_TAG_BYTES }).text.trim())
				.filter((tag) => tag.length > 0),
		),
	).slice(0, MAX_TAGS);
	if (out.length === 0) return undefined;
	return out;
}

function buildEvidence(snapshot: LastRunSnapshot) {
	let includeGit = true;
	let includeDiffFiles = true;
	let includeTools = true;
	let includeContext = true;
	const dropped: string[] = [];

	while (true) {
		const items = [
			toEvidence("error", buildErrorSummary(snapshot), "error_summary"),
			toEvidence(
				"diff_summary",
				buildDiffSummary(snapshot, includeDiffFiles),
				"diff_summary",
			),
			...(includeContext
				? snapshot.contextGaps
						.map((gap, index) =>
							toEvidence(
								"context_gap",
								`context gap: ${gap}`,
								`context_gap_${index}`,
							),
						)
						.filter((item): item is EvidenceBuild => !!item)
				: []),
			...(includeTools
				? [toEvidence("tool", buildToolSummary(snapshot), "tool_timeline")]
				: []),
			...(includeGit
				? [
						toEvidence(
							"git_status",
							buildGitStatus(snapshot) ?? "",
							"git_status",
						),
					]
				: []),
		].filter((item): item is EvidenceBuild => !!item);

		const total = items.reduce((sum, item) => sum + item.item.byteCount, 0);
		if (total <= DEFAULT_FAILURE_TOTAL_BYTES) {
			return {
				items,
				dropped,
			};
		}

		if (includeGit && items.some((item) => item.key === "git_status")) {
			includeGit = false;
			dropped.push("git_status");
			continue;
		}
		if (includeDiffFiles) {
			includeDiffFiles = false;
			dropped.push("diff_file_list");
			continue;
		}
		if (includeTools && items.some((item) => item.key === "tool_timeline")) {
			includeTools = false;
			dropped.push("tool_timeline");
			continue;
		}
		if (includeContext && snapshot.contextGaps.length > 0) {
			includeContext = false;
			dropped.push("context_gaps");
			continue;
		}

		return {
			items,
			dropped,
		};
	}
}

function renderText(payload: {
	preview: boolean;
	persisted: boolean;
	deduped: boolean;
	recordId: string;
	existingId?: string;
	evidenceCount: number;
	byteCount: number;
	tokenEstimate: number;
	redactions: number;
	storageRoot: string;
	deleteInstructions: string;
	failuresPath: string;
	summaryPath: string;
}) {
	const lines = [
		payload.preview
			? "PREVIEW: failure record was not persisted"
			: "Recorded failure",
		`record id: ${payload.recordId}`,
		`evidence: count=${payload.evidenceCount} bytes=${payload.byteCount} tokenEstimate=${payload.tokenEstimate}`,
		`redaction: replacements=${payload.redactions}`,
		`storage root: ${payload.storageRoot}`,
		`files: failures=${payload.failuresPath} summary=${payload.summaryPath}`,
		`delete instructions: ${payload.deleteInstructions}`,
	];
	if (payload.deduped && payload.existingId) {
		lines.push(`dedupe: existing record reused (${payload.existingId})`);
	}
	if (payload.preview) {
		lines.push("confirm: re-run with --yes to persist this failure record");
	}
	if (payload.persisted) {
		lines.push("status: persisted");
	}
	return lines.join("\n");
}

export async function renderRecordFailure(
	worktree: string,
	args: RecordFailureArgs = {},
) {
	const yes = Boolean(args.yes);
	const json = Boolean(args.json);
	const projectPaths = await resolvePostmortemRoot(worktree);
	const root = projectPaths.root;
    const snapshotPath = path.join(root, "last-run.json");

    // Load snapshot safely: if missing or corrupt, return actionable message
    let snapshot: LastRunSnapshot;
    const noSnapshotMsg = `No rolling snapshot found at ${snapshotPath}. Run your test/CI to generate a snapshot (creates last-run.json in the project postmortem root).`;
    const corruptSnapshotMsg = `Rolling snapshot at ${snapshotPath} is missing or corrupt. Remove or regenerate the snapshot before recording failures.`;

    const raw = await fs.readFile(snapshotPath, "utf8").catch(() => null);
    if (!raw) {
        const payload = { error: noSnapshotMsg };
        if (json) return JSON.stringify(payload);
        return noSnapshotMsg;
    }

    // parse safely and validate with schema parser; on failure return corrupt message
    const parsed = await Promise.resolve()
        .then(() => JSON.parse(raw))
        .catch(() => null);
    if (!parsed) {
        const payload = { error: corruptSnapshotMsg };
        if (json) return JSON.stringify(payload);
        return corruptSnapshotMsg;
    }

    try {
        snapshot = LastRunSnapshot.parse(parsed);
    } catch {
        const payload = { error: corruptSnapshotMsg };
        if (json) return JSON.stringify(payload);
        return corruptSnapshotMsg;
    }
	const now = new Date().toISOString();
	const storePaths = storePathsFromRoot(root);
	const built = buildEvidence(snapshot);
	const evidence = built.items.map((item) => item.item);
	const byteCount = evidence.reduce((sum, item) => sum + item.byteCount, 0);
	const tokenEstimate = evidence.reduce(
		(sum, item) => sum + item.tokenEstimate,
		0,
	);
	const redactions = built.items.reduce(
		(sum, item) => sum + item.redactions,
		0,
	);
	const reason = sanitizeReason(args.reason);
	const tags = sanitizeTags(args.tags);
	const toolFailureHash = buildToolFailureHash(snapshot);
	const signature = {
		messageHash: buildMessageHash(snapshot),
		...(toolFailureHash ? { toolFailureHash } : {}),
	};
	const baseRecord = {
		schemaVersion: FAILURE_RECORD_SCHEMA_VERSION,
		id: crypto.randomUUID(),
		projectId: projectPaths.projectId,
		createdAt: now,
		sessionId: snapshot.sessionID,
		signature,
		evidence,
		redactionReport: {
			totalReplacements: redactions,
			patterns: mergePatternCounts(built.items),
			droppedDueToCaps: built.items.some((item) => item.capped),
		},
		...(reason || tags || built.dropped.length > 0
			? {
					selectionTrace: {
						...(reason ? { reason } : {}),
						...(tags ? { tags } : {}),
						...(built.dropped.length > 0
							? { droppedEvidence: built.dropped }
							: {}),
					},
				}
			: {}),
	} satisfies FailureRecord;
	const record = {
		...baseRecord,
		analysis: buildDeterministicAnalysis(baseRecord),
	} satisfies FailureRecord;

	const loaded = await loadFailureRecords(root);
	const existing = loaded.records.find((item) => matchesDedupe(item, record));
	let persisted = false;
	let deduped = false;
	let recordId: string = record.id;

	if (yes && existing) {
		deduped = true;
		recordId = existing.id;
	}

	if (yes && !existing) {
		await appendFailureRecord(root, record);
		const reloaded = await loadFailureRecords(root);
		await writeSummary(root, reloaded.records);
		persisted = true;
	}

	const payload = {
		mode: yes ? "persist" : "preview",
		preview: !yes,
		persisted,
		deduped,
		recordId,
		...(existing ? { existingId: existing.id } : {}),
		projectId: projectPaths.projectId,
		sessionId: snapshot.sessionID,
		signature: record.signature,
		evidenceCount: evidence.length,
		byteCount,
		tokenEstimate,
		redactions,
		redaction: {
			replacements: redactions,
			patterns: mergePatternCounts(built.items),
		},
		storageRoot: root,
		snapshotPath,
		failuresPath: storePaths.failures,
		summaryPath: storePaths.summary,
		droppedEvidence: built.dropped,
		deleteInstructions: `rm -rf "${root}"`,
		...(yes
			? {}
			: { confirm: "Re-run with --yes to persist this failure record." }),
	};

	if (json) return JSON.stringify(payload);
	return renderText(payload);
}
