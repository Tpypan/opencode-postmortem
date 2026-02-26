import crypto from "node:crypto";
import {
	DEFAULT_EVIDENCE_ITEM_BYTES,
	DEFAULT_SNAPSHOT_TOTAL_BYTES,
	redact,
} from "../redaction";
import {
	LastRunSnapshot,
	SNAPSHOT_SCHEMA_VERSION,
	type SnapshotDiffFile,
	type SnapshotDropSection,
	type SnapshotError,
	type SnapshotTool,
	type SnapshotToolStatus,
} from "./model";

const MAX_ERROR_SNIPPET_BYTES = 1024;
const MAX_TOOL_TEXT_BYTES = 160;
const MAX_FILE_TEXT_BYTES = 512;
const MAX_GIT_LINE_BYTES = 512;
const MAX_TOOL_CALLS = 400;
const MAX_ERRORS = 120;
const MAX_DIFF_FILES = 300;
const MAX_GIT_LINES = 200;
const MAX_CONTEXT_GAPS = 12;

const contextGapRules = [
	{
		regex:
			/(?:missing|undefined|not set|expected).*(?:env|environment variable|api key|token|secret)/i,
		text: "Missing required environment variable or secret.",
	},
	{
		regex: /(?:enoent|no such file|file not found|cannot find file|not found)/i,
		text: "Missing file or incorrect path in workspace context.",
	},
	{
		regex:
			/(?:permission denied|eacces|operation not permitted|read-only file system)/i,
		text: "Permission issue blocked a required operation.",
	},
	{
		regex:
			/(?:command not found|is not recognized as an internal or external command)/i,
		text: "Required CLI tool appears unavailable in environment.",
	},
	{
		regex:
			/(?:module not found|cannot find module|package .* not found|could not resolve)/i,
		text: "Missing dependency or unresolved module reference.",
	},
	{
		regex:
			/(?:timed out|timeout|econnrefused|connection refused|network error|dns)/i,
		text: "Network connectivity issue interrupted execution.",
	},
] as const;

type ToolStateInput = {
	status?: unknown;
	error?: unknown;
	time?: {
		start?: unknown;
		end?: unknown;
	};
	metadata?: Record<string, unknown>;
};

type ToolPartInput = {
	type?: unknown;
	tool?: unknown;
	state?: ToolStateInput;
};

export type BuildLastRunSnapshotInput = {
	projectId: string;
	sessionID: string;
	messages: Array<SnapshotMessageInput>;
	diffs: Array<SnapshotDiffInput>;
	gitStatusLines?: Array<string>;
	gitStatusTruncated?: boolean;
	capturedAt?: string;
};

export type BuildLastRunSnapshotOptions = {
	redact?: boolean;
};

export type SnapshotDiffInput = {
	file: string;
	additions: number;
	deletions: number;
};

export type SnapshotMessageInput = {
	parts: Array<ToolPartInput>;
};

function bytes(text: string) {
	return Buffer.byteLength(text, "utf8");
}

function cap(text: string, maxBytes: number) {
	if (maxBytes <= 0) return "";
	if (bytes(text) <= maxBytes) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const size = Buffer.byteLength(ch, "utf8");
		if (used + size > maxBytes) return out;
		out += ch;
		used += size;
	}
	return out;
}

function clean(text: string, maxBytes: number, shouldRedact: boolean) {
	const limit = Math.min(maxBytes, DEFAULT_EVIDENCE_ITEM_BYTES);
	const out = shouldRedact ? redact(text).text : text;
	return cap(out, limit).trim();
}

function positiveInteger(value: unknown) {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value)) return undefined;
	if (value < 0) return undefined;
	return Math.round(value);
}

function keep<T>(
	items: Array<T>,
	max: number,
	section: SnapshotDropSection,
	dropped: Set<SnapshotDropSection>,
) {
	if (items.length <= max) return items;
	dropped.add(section);
	return items.slice(0, max);
}

function isToolStatus(value: unknown): value is SnapshotToolStatus {
	return (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "error"
	);
}

function isToolPart(
	part: ToolPartInput,
): part is ToolPartInput & { tool: string; state: ToolStateInput } {
	return part.type === "tool" && typeof part.tool === "string" && !!part.state;
}

function resolveDuration(state: ToolStateInput) {
	const start = positiveInteger(state.time?.start);
	const end = positiveInteger(state.time?.end);
	if (start !== undefined && end !== undefined && end >= start) {
		return end - start;
	}

	const fromMetadata = positiveInteger(state.metadata?.duration);
	if (fromMetadata !== undefined) return fromMetadata;
	return undefined;
}

function inferContextGaps(errors: Array<string>) {
	const gaps = contextGapRules
		.filter((rule) => errors.some((error) => rule.regex.test(error)))
		.map((rule) => rule.text);
	return Array.from(new Set(gaps)).slice(0, MAX_CONTEXT_GAPS);
}

function statusRank(status: SnapshotToolStatus) {
	if (status === "error") return 3;
	if (status === "running") return 2;
	if (status === "pending") return 1;
	return 0;
}

function compareTools(a: SnapshotTool, b: SnapshotTool) {
	const rank = statusRank(b.status) - statusRank(a.status);
	if (rank !== 0) return rank;
	const duration = (b.durationMs ?? -1) - (a.durationMs ?? -1);
	if (duration !== 0) return duration;
	return a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;
}

function compactTools(tools: Array<SnapshotTool>) {
	const grouped = new Map<string, SnapshotTool>();
	for (const item of tools) {
		const existing = grouped.get(item.tool);
		if (!existing) {
			grouped.set(item.tool, item);
			continue;
		}

		const status =
			statusRank(item.status) > statusRank(existing.status)
				? item.status
				: existing.status;
		const durationMs =
			typeof item.durationMs === "number" &&
			typeof existing.durationMs === "number"
				? Math.max(item.durationMs, existing.durationMs)
				: (item.durationMs ?? existing.durationMs);
		grouped.set(item.tool, {
			tool: item.tool,
			status,
			...(durationMs === undefined ? {} : { durationMs }),
		});
	}
	return Array.from(grouped.values()).sort(compareTools);
}

function errorKey(error: SnapshotError) {
	const normalized = error.snippet.replace(/\s+/g, " ").trim();
	const hash = crypto
		.createHash("sha256")
		.update(`${error.tool}\u0000${normalized}`, "utf8")
		.digest("hex")
		.slice(0, 16);
	return `${error.tool}:${hash}`;
}

function errorScore(error: SnapshotError) {
	return error.snippet.length;
}

function compareErrors(a: SnapshotError, b: SnapshotError) {
	const score = errorScore(b) - errorScore(a);
	if (score !== 0) return score;
	if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
	return a.snippet < b.snippet ? -1 : a.snippet > b.snippet ? 1 : 0;
}

function compactErrors(errors: Array<SnapshotError>) {
	const grouped = new Map<string, SnapshotError>();
	for (const item of errors) {
		const key = errorKey(item);
		const existing = grouped.get(key);
		if (!existing || errorScore(item) > errorScore(existing)) {
			grouped.set(key, item);
		}
	}
	return Array.from(grouped.values()).sort(compareErrors);
}

function compareDiffFiles(a: SnapshotDiffFile, b: SnapshotDiffFile) {
	const impact =
		b.additions + b.deletions - (a.additions + a.deletions);
	if (impact !== 0) return impact;
	return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function compactDiffFiles(files: Array<SnapshotDiffFile>) {
	const grouped = new Map<string, SnapshotDiffFile>();
	for (const item of files) {
		const existing = grouped.get(item.file);
		if (!existing) {
			grouped.set(item.file, item);
			continue;
		}
		grouped.set(item.file, {
			file: item.file,
			additions: existing.additions + item.additions,
			deletions: existing.deletions + item.deletions,
		});
	}
	return Array.from(grouped.values()).sort(compareDiffFiles);
}

function summarizeDiffs(
	diffs: Array<SnapshotDiffInput>,
	dropped: Set<SnapshotDropSection>,
	shouldRedact: boolean,
) {
	const ranked = compactDiffFiles(
		diffs
			.map((diff) => {
				const file = clean(diff.file, MAX_FILE_TEXT_BYTES, shouldRedact);
				if (!file) return undefined;
				return {
					file,
					additions: positiveInteger(diff.additions) ?? 0,
					deletions: positiveInteger(diff.deletions) ?? 0,
				} satisfies SnapshotDiffFile;
			})
			.filter((file): file is SnapshotDiffFile => !!file),
	);

	const files = keep(
		ranked,
		MAX_DIFF_FILES,
		"diff_files",
		dropped,
	);

	return {
		totalFiles: diffs.length,
		additions: diffs.reduce(
			(sum, diff) => sum + (positiveInteger(diff.additions) ?? 0),
			0,
		),
		deletions: diffs.reduce(
			(sum, diff) => sum + (positiveInteger(diff.deletions) ?? 0),
			0,
		),
		files,
	};
}

function fitWithinSnapshotCap(
	snapshot: LastRunSnapshot,
	dropped: Set<SnapshotDropSection>,
) {
	const out = structuredClone(snapshot);
	const oversize = () =>
		bytes(JSON.stringify(out)) > DEFAULT_SNAPSHOT_TOTAL_BYTES;
	const sectionBytes = () => {
		const scores = [
			{
				section: "errors" as const,
				bytes: out.errors.length > 0 ? bytes(JSON.stringify(out.errors)) : -1,
			},
			{
				section: "tools" as const,
				bytes: out.tools.length > 0 ? bytes(JSON.stringify(out.tools)) : -1,
			},
			{
				section: "diff_files" as const,
				bytes:
					out.diff.files.length > 0
						? bytes(JSON.stringify(out.diff.files))
						: -1,
			},
		].sort((a, b) => {
			if (a.bytes !== b.bytes) return b.bytes - a.bytes;
			const order = {
				errors: 0,
				tools: 1,
				diff_files: 2,
			} as const;
			return order[a.section] - order[b.section];
		});
		return scores[0];
	};

	if (oversize() && out.gitStatus) {
		out.gitStatus = undefined;
		dropped.add("git_status");
	}

	if (oversize() && out.contextGaps.length > 0) {
		out.contextGaps = [];
		dropped.add("context_gaps");
	}

	if (oversize() && out.tools.length > 0) {
		const compacted = compactTools(out.tools);
		if (compacted.length < out.tools.length) dropped.add("tools");
		out.tools = compacted;
	}

	if (oversize() && out.errors.length > 0) {
		const compacted = compactErrors(out.errors);
		if (compacted.length < out.errors.length) dropped.add("errors");
		out.errors = compacted;
	}

	if (oversize() && out.diff.files.length > 0) {
		const compacted = compactDiffFiles(out.diff.files);
		if (compacted.length < out.diff.files.length) dropped.add("diff_files");
		out.diff.files = compacted;
	}

	while (
		oversize() &&
		(out.errors.length > 0 || out.tools.length > 0 || out.diff.files.length > 0)
	) {
		const candidate = sectionBytes();
		if (candidate.section === "errors" && out.errors.length > 0) {
			out.errors = out.errors.slice(0, -1);
			dropped.add("errors");
			continue;
		}
		if (candidate.section === "tools" && out.tools.length > 0) {
			out.tools = out.tools.slice(0, -1);
			dropped.add("tools");
			continue;
		}
		if (candidate.section === "diff_files" && out.diff.files.length > 0) {
			out.diff.files = out.diff.files.slice(0, -1);
			dropped.add("diff_files");
			continue;
		}
		break;
	}

	if (oversize()) {
		out.tools = [];
		out.errors = [];
		out.diff.files = [];
		out.contextGaps = [];
		out.gitStatus = undefined;
		dropped.add("tools");
		dropped.add("errors");
		dropped.add("diff_files");
		dropped.add("context_gaps");
		dropped.add("git_status");
	}

	out.meta.droppedDueToCaps = dropped.size > 0;
	out.meta.droppedSections = Array.from(dropped);
	return out;
}

export function buildLastRunSnapshot(
	input: BuildLastRunSnapshotInput,
	options: BuildLastRunSnapshotOptions = {},
) {
	const shouldRedact = options.redact !== false;
	const dropped = new Set<SnapshotDropSection>();
	const toolParts = input.messages.flatMap((message) =>
		message.parts.filter(isToolPart),
	);
	const tools = keep(
		toolParts
			.map((part) => {
				if (!isToolStatus(part.state.status)) return undefined;
				const tool = clean(part.tool, MAX_TOOL_TEXT_BYTES, shouldRedact);
				if (!tool) return undefined;
				const durationMs = resolveDuration(part.state);
				return {
					tool,
					status: part.state.status,
					...(durationMs === undefined ? {} : { durationMs }),
				} satisfies SnapshotTool;
			})
			.filter((item): item is SnapshotTool => !!item),
		MAX_TOOL_CALLS,
		"tools",
		dropped,
	);

	const errors = keep(
		toolParts
			.map((part) => {
				if (part.state.status !== "error") return undefined;
				const tool = clean(part.tool, MAX_TOOL_TEXT_BYTES, shouldRedact);
				const snippet = clean(
					typeof part.state.error === "string" ? part.state.error : "",
					MAX_ERROR_SNIPPET_BYTES,
					shouldRedact,
				);
				if (!tool || !snippet) return undefined;
				return {
					tool,
					snippet,
				} satisfies SnapshotError;
			})
			.filter((item): item is SnapshotError => !!item),
		MAX_ERRORS,
		"errors",
		dropped,
	);

	// Compute deterministic short errorSignature from errors/tools for dedupe/relevance.
	// Use sha256 and take first 24 hex chars (96 bits) to keep snapshots small.
	let errorSignature: string | undefined;
	if (errors.length > 0) {
		const hashInput = JSON.stringify({
			errors: errors.map((e) => ({ tool: e.tool, snippet: e.snippet })),
			tools: tools.map((t) => ({ tool: t.tool, status: t.status })),
		});
		const full = crypto
			.createHash("sha256")
			.update(hashInput, "utf8")
			.digest("hex");
		errorSignature = full.slice(0, 24);
	}

	const gitLines = input.gitStatusLines
		? keep(
				input.gitStatusLines
					.map((line) => clean(line, MAX_GIT_LINE_BYTES, shouldRedact))
					.filter((line) => line.length > 0),
				MAX_GIT_LINES,
				"git_status",
				dropped,
			)
		: undefined;

	const contextGaps = inferContextGaps(errors.map((error) => error.snippet));
	if (contextGaps.length >= MAX_CONTEXT_GAPS) dropped.add("context_gaps");

	const snapshot = LastRunSnapshot.parse({
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		projectId: clean(input.projectId, MAX_TOOL_TEXT_BYTES, shouldRedact),
		sessionID: clean(input.sessionID, MAX_TOOL_TEXT_BYTES, shouldRedact),
		capturedAt: input.capturedAt ?? new Date().toISOString(),
		tools,
		errors,
		diff: summarizeDiffs(input.diffs, dropped, shouldRedact),
		gitStatus: gitLines
			? {
					lines: gitLines,
					truncated: Boolean(
						input.gitStatusTruncated || dropped.has("git_status"),
					),
				}
			: undefined,
		contextGaps,
		meta: {
			droppedDueToCaps: dropped.size > 0,
			droppedSections: Array.from(dropped),
			source: {
				messageCount: input.messages.length,
				toolCallCount: toolParts.length,
				diffFileCount: input.diffs.length,
				gitRepo: input.gitStatusLines !== undefined,
			},
		},
		...(errorSignature ? { errorSignature } : {}),
	});

	return LastRunSnapshot.parse(fitWithinSnapshotCap(snapshot, dropped));
}

export function buildLastRunMarkdown(snapshot: LastRunSnapshot) {
	const lines = [
		"# Last Run Snapshot",
		"",
		`- Captured: ${snapshot.capturedAt}`,
		`- Session: ${snapshot.sessionID}`,
		`- Tools: ${snapshot.tools.length}`,
		`- Errors: ${snapshot.errors.length}`,
		"",
		"## Tool Timeline",
		...(snapshot.tools.length
			? snapshot.tools.map((item) => {
					const duration =
						item.durationMs !== undefined ? ` (${item.durationMs}ms)` : "";
					return `- ${item.tool}: ${item.status}${duration}`;
				})
			: ["- none"]),
		"",
		"## Error Summaries",
		...(snapshot.errors.length
			? snapshot.errors.map((item) => `- ${item.tool}: ${item.snippet}`)
			: ["- none"]),
		"",
		"## Diff Summary",
		`- Totals: files=${snapshot.diff.totalFiles} additions=${snapshot.diff.additions} deletions=${snapshot.diff.deletions}`,
		...(snapshot.diff.files.length
			? snapshot.diff.files.map(
					(file) => `- ${file.file} (+${file.additions}/-${file.deletions})`,
				)
			: ["- none"]),
		"",
		"## Context Gaps",
		...(snapshot.contextGaps.length
			? snapshot.contextGaps.map((gap) => `- ${gap}`)
			: ["- none"]),
	];

	if (!snapshot.gitStatus) return lines.join("\n");

	return [
		...lines,
		"",
		"## Git Status (porcelain)",
		...(snapshot.gitStatus.lines.length
			? snapshot.gitStatus.lines.map((line) => `- ${line}`)
			: ["- clean"]),
	].join("\n");
}
