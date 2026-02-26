import fs from "node:fs/promises";
import path from "node:path";
import { INJECTION_HEADER } from "./injection";
import type { GuardrailRule } from "./model";
import { redact } from "./redaction";
import {
    contextFromSnapshot,
    type SelectGuardrailsResult,
    type SelectionTraceItem,
    selectGuardrails,
} from "./selection";
import { LastRunSnapshot } from "./snapshot/model";
import { resolvePostmortemRoot } from "./storage/paths";
import { loadRules } from "./store/rules";

const DEFAULT_MAX_RETRY_DEPTH = 3;
const ROLE_PREFIX = /^\s*(?:system|assistant|user|tool)\s*:\s*/i;
const SNAPSHOT_FILE = "last-run.json";
const SNAPSHOT_REMEDIATION =
	"Delete this file and re-run a session to regenerate it.";

type RetryMessage = {
	info?: {
		role?: string;
	};
	parts?: Array<{
		type?: string;
		text?: string;
	}>;
};

type RetryClient = {
	session: {
		messages(input: {
			path: { id: string };
		}): Promise<{ data?: RetryMessage[] }>;
	};
};

type SnapshotData = ReturnType<(typeof LastRunSnapshot)["parse"]>;
type SnapshotLoadResult =
	| {
		ok: true;
		snapshot: SnapshotData;
	}
	| {
		ok: false;
		kind: "missing" | "empty" | "invalid_json" | "invalid_schema" | "unreadable";
		snapshotPath: string;
		error: string;
	};

export type RetryArgs = {
    yes?: boolean;
    explain?: boolean;
    skip?: string[];
    json?: boolean;
};

export type RetryToolOptions = {
	maxDepth?: number;
};

function sanitizeRuleText(text: string) {
	const cleaned = text
		.split(/\r?\n/g)
		.map((line) => line.replace(ROLE_PREFIX, " "))
		.join(" ")
		.replaceAll("```", " ")
		.replaceAll("`", " ")
		.replace(/\s+/g, " ")
		.trim();

	return redact(cleaned).text.replace(/\s+/g, " ").trim();
}

function short(text: string, max = 90) {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function promptFromMessages(messages: RetryMessage[]) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.info?.role !== "user") continue;
		const text = (message.parts ?? [])
			.filter((part) => part.type === "text")
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("\n")
			.trim();
		if (!text) continue;
		if (text.startsWith("/")) continue;
		return text;
	}

	return undefined;
}

async function loadSnapshot(root: string): Promise<SnapshotLoadResult> {
	const snapshotPath = path.join(root, SNAPSHOT_FILE);
	const raw = await fs.readFile(snapshotPath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error?.code === "ENOENT") return undefined;
		return null;
	});
	if (raw === undefined) {
		return {
			ok: false,
			kind: "missing",
			snapshotPath,
			error: `No last-run snapshot found at ${snapshotPath}. Run a session first.`,
		};
	}
	if (raw === null) {
		return {
			ok: false,
			kind: "unreadable",
			snapshotPath,
			error: `Could not read last-run snapshot at ${snapshotPath}. ${SNAPSHOT_REMEDIATION}`,
		};
	}
	if (!raw.trim()) {
		return {
			ok: false,
			kind: "empty",
			snapshotPath,
			error: `Last-run snapshot at ${snapshotPath} is empty. ${SNAPSHOT_REMEDIATION}`,
		};
	}

	const parsedJSON = await Promise.resolve(raw)
		.then((text) => JSON.parse(text))
		.catch(() => undefined);
	if (parsedJSON === undefined) {
		return {
			ok: false,
			kind: "invalid_json",
			snapshotPath,
			error: `Last-run snapshot at ${snapshotPath} is not valid JSON. ${SNAPSHOT_REMEDIATION}`,
		};
	}

	const parsed = LastRunSnapshot.safeParse(parsedJSON);
	if (!parsed.success) {
		return {
			ok: false,
			kind: "invalid_schema",
			snapshotPath,
			error: `Last-run snapshot at ${snapshotPath} does not match the expected schema. ${SNAPSHOT_REMEDIATION}`,
		};
	}

	return { ok: true, snapshot: parsed.data };
}

function explainText(selected: SelectGuardrailsResult) {
	return JSON.stringify(
		{
			selectedIds: selected.selectedIds,
			tokenCap: selected.tokenCap,
			tokenEstimate: selected.tokenEstimate,
			trace: selected.trace.map((item) => ({
				id: item.id,
				selected: item.selected,
				dropReason: item.dropReason ?? null,
				score: item.score,
				tokenEstimate: item.tokenEstimate,
				matchCounts: item.matchCounts,
			})),
		},
		null,
		2,
	);
}

function promptBlock(rules: GuardrailRule[], userPrompt: string) {
	const lines = rules
		.map((rule) => sanitizeRuleText(rule.rule.text))
		.filter((text) => text.length > 0)
		.map((text, index) => `${index + 1}. ${text}`);

	return [INJECTION_HEADER, ...lines, "---", userPrompt].join("\n");
}

function previewText(input: {
	selected: SelectGuardrailsResult;
	skipIds: string[];
	userPrompt: string;
}) {
	const selectedRules = input.selected.selected.map((rule) => ({
		id: rule.id,
		text: sanitizeRuleText(rule.rule.text),
	}));
	const lines = [
		"PREVIEW: retry prompt is not emitted without --yes",
		`selected guardrails: ${selectedRules.length}`,
		...selectedRules.map((rule) => `- ${rule.id}: ${short(rule.text)}`),
		`prompt preview: ${short(input.userPrompt, 120)}`,
		"confirm: re-run with --yes to emit the ready-to-run retry prompt",
	];

	if (input.skipIds.length > 0) {
		lines.splice(2, 0, `skip list: ${input.skipIds.join(",")}`);
	}

	return lines.join("\n");
}

export function createRetryRenderer(options: RetryToolOptions = {}) {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_RETRY_DEPTH;
	const depth = new Map<string, number>();

    return async function renderRetry(
		worktree: string,
		client: RetryClient,
		sessionID: string,
		args: RetryArgs = {},
	) {
        const paths = await resolvePostmortemRoot(worktree);
		const [snapshotResult, rules, messagesResult] = await Promise.all([
			loadSnapshot(paths.root),
			loadRules(paths.root).catch(() => []),
			client.session
				.messages({ path: { id: sessionID } })
				.catch(() => ({ data: [] })),
		]);

		if (!snapshotResult.ok) {
			if (args.json && snapshotResult.kind !== "missing") {
				return JSON.stringify({
					ok: false,
					error: snapshotResult.error,
					snapshotPath: snapshotResult.snapshotPath,
					kind: snapshotResult.kind,
				});
			}
			if (args.json) {
				return JSON.stringify({ ok: false, error: snapshotResult.error });
			}
			return snapshotResult.error;
		}

			const userPrompt = promptFromMessages(messagesResult.data ?? []);
            if (!userPrompt) {
                if (args.json) return JSON.stringify({ ok: false, error: "Could not find a retryable last user prompt in this session history." });
                return "Could not find a retryable last user prompt in this session history.";
            }

		const skipIds = Array.from(
			new Set(
				(args.skip ?? [])
					.map((item) => item.trim())
					.filter((item) => item.length > 0),
			),
		).sort((a, b) => a.localeCompare(b));
		const selected = selectGuardrails({
			rules,
			context: contextFromSnapshot(snapshotResult.snapshot),
			skipIds,
		});
			const explain = args.explain
				? `\n\nSELECTION TRACE\n${explainText(selected)}`
				: "";

            if (!args.yes) {
                if (args.json) {
                    type RetryJsonOutput = {
                        ok: boolean;
                        emitted: false;
                        selectedIds: string[];
                        skipIds: string[];
                        tokenCap: number;
                        tokenEstimate: number;
                        promptPreview: string;
                        trace?: SelectionTraceItem[];
                    };
                    const payload: RetryJsonOutput = {
                        ok: true,
                        emitted: false,
                        selectedIds: selected.selectedIds,
                        skipIds,
                        tokenCap: selected.tokenCap,
                        tokenEstimate: selected.tokenEstimate,
                        promptPreview: short(userPrompt, 120),
                    };
                    if (args.explain) payload.trace = selected.trace;
                    return JSON.stringify(payload);
                }
                return `${previewText({ selected, skipIds, userPrompt })}${explain}`;
            }

			const current = depth.get(sessionID) ?? 0;
			const next = current + 1;
            if (next > maxDepth) {
                if (args.json) return JSON.stringify({ ok: false, error: `Retry limit reached for session ${sessionID}: max depth ${maxDepth}. Start a fresh prompt instead of retrying recursively.` });
                return `Retry limit reached for session ${sessionID}: max depth ${maxDepth}. Start a fresh prompt instead of retrying recursively.`;
            }
		depth.set(sessionID, next);

			const prompt = promptBlock(selected.selected, userPrompt);
            if (args.json) {
                type RetryJsonOutput = {
                    ok: true;
                    emitted: true;
                    selectedIds: string[];
                    skipIds: string[];
                    tokenCap: number;
                    tokenEstimate: number;
                    promptPreview: string;
                    prompt: string;
                    trace?: SelectionTraceItem[];
                };
                const payload: RetryJsonOutput = {
                    ok: true,
                    emitted: true,
                    selectedIds: selected.selectedIds,
                    skipIds,
                    tokenCap: selected.tokenCap,
                    tokenEstimate: selected.tokenEstimate,
                    promptPreview: short(userPrompt, 120),
                    prompt,
                };
                if (args.explain) payload.trace = selected.trace;
                return JSON.stringify(payload);
            }
			return explain ? `${prompt}${explain}` : prompt;
	};
}
