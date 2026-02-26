import type {
	FailureRecord,
	GuardrailMatch,
	WhyFailedAnalysis,
	WhyFailedCitation,
	WhyFailedHypothesis,
	WhyFailedRuleSuggestion,
} from "./model";

const FailureOrder = [
	"missing_env",
	"missing_file",
	"test_failure",
	"wrong_file",
	"unknown",
] as const;

const Matchers = {
	missing_env: [
		/missing required environment variable/i,
		/environment variable .* not set/i,
		/secret .* not set/i,
		/\bnot set\b/i,
	],
	missing_file: [
		/\benoent\b/i,
		/no such file/i,
		/file not found/i,
		/cannot find module/i,
	],
	test_failure: [
		/\bassertionerror\b/i,
		/\bFAIL\b/i,
		/\btest\b.*\b(fail|error)/i,
		/\bexpected\b.*\bto\b/i,
	],
	wrong_file: [
		/wrong file/i,
		/incorrect file/i,
		/unrelated file/i,
		/edited .* but/i,
	],
} as const;

const Explanations = {
	missing_env:
		"Failure likely caused by missing or unset environment variables.",
	missing_file:
		"Failure likely caused by missing path/module/file inputs at runtime.",
	test_failure: "Failure likely caused by a failing automated test assertion.",
	wrong_file:
		"Failure likely caused by editing or selecting an incorrect file.",
	unknown: "Evidence does not strongly match a known failure type.",
} as const;

const RuleTemplates = {
	missing_env: {
		severity: "must",
		text: "Validate required env vars before execution and fail fast when any required key is unset.",
		keywords: ["env", "not set", "missing"],
	},
	missing_file: {
		severity: "must",
		text: "Verify required files and modules exist before run, and print the missing path in errors.",
		keywords: ["ENOENT", "file not found", "path"],
	},
	test_failure: {
		severity: "should",
		text: "Run targeted tests before merge and block changes when assertion failures are detected.",
		keywords: ["test", "assertion", "fail"],
	},
	wrong_file: {
		severity: "should",
		text: "Require explicit target-path confirmation before edits when selection signals possible wrong-file risk.",
		keywords: ["wrong file", "selection", "path"],
	},
	unknown: {
		severity: "should",
		text: "Capture richer tool and path evidence on failures to improve deterministic failure typing.",
		keywords: ["evidence", "tool", "path"],
	},
} as const;

type Signal = {
	type: WhyFailedHypothesis["type"];
	score: number;
	citations: Array<WhyFailedCitation>;
};

function safeTrace(record: FailureRecord) {
	if (!record.selectionTrace || typeof record.selectionTrace !== "object") {
		return {
			reason: "",
			tags: [] as string[],
			paths: [] as string[],
		};
	}

	const trace = record.selectionTrace as Record<string, unknown>;
	const reason = typeof trace.reason === "string" ? trace.reason : "";
	const tags = Array.isArray(trace.tags)
		? trace.tags.filter((value): value is string => typeof value === "string")
		: [];
	const paths = Array.isArray(trace.paths)
		? trace.paths.filter((value): value is string => typeof value === "string")
		: [];

	return { reason, tags, paths };
}

function dedupeCitations(citations: Array<WhyFailedCitation>, max = 5) {
	const seen = new Set<string>();
	return citations
		.filter((item) => {
			const key = `${item.type}:${item.hash}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, max);
}

function collect(record: FailureRecord) {
	const trace = safeTrace(record);
	const text = [trace.reason, ...trace.tags].join("\n").toLowerCase();
	const out: Record<Signal["type"], Signal> = {
		missing_env: { type: "missing_env", score: 0, citations: [] },
		missing_file: { type: "missing_file", score: 0, citations: [] },
		test_failure: { type: "test_failure", score: 0, citations: [] },
		wrong_file: { type: "wrong_file", score: 0, citations: [] },
		unknown: { type: "unknown", score: 1, citations: [] },
	};

	for (const item of record.evidence ?? []) {
		const citation = {
			type: item.type,
			hash: item.hash,
		} satisfies WhyFailedCitation;
		const content = item.redactedText.toLowerCase();

		if (Matchers.missing_env.some((pattern) => pattern.test(content))) {
			out.missing_env.score += 3;
			out.missing_env.citations.push(citation);
			out.unknown.score = 0;
		}
		if (Matchers.missing_file.some((pattern) => pattern.test(content))) {
			out.missing_file.score += 3;
			out.missing_file.citations.push(citation);
			out.unknown.score = 0;
		}
		if (Matchers.test_failure.some((pattern) => pattern.test(content))) {
			out.test_failure.score += 2;
			out.test_failure.citations.push(citation);
			out.unknown.score = 0;
		}
		if (Matchers.wrong_file.some((pattern) => pattern.test(content))) {
			out.wrong_file.score += 2;
			out.wrong_file.citations.push(citation);
			out.unknown.score = 0;
		}
	}

	const fallback = record.evidence?.[0];
	function applyTextMatch(type: Signal["type"], increment: number) {
		out[type].score += increment;
		if (out[type].citations.length === 0 && fallback) {
			out[type].citations.push({ type: fallback.type, hash: fallback.hash });
		}
		out.unknown.score = 0;
	}

	if (Matchers.missing_env.some((pattern) => pattern.test(text))) {
		applyTextMatch("missing_env", 3);
	}
	if (Matchers.missing_file.some((pattern) => pattern.test(text))) {
		applyTextMatch("missing_file", 3);
	}
	if (Matchers.test_failure.some((pattern) => pattern.test(text))) {
		applyTextMatch("test_failure", 2);
	}
	if (
		Matchers.wrong_file.some((pattern) => pattern.test(text)) ||
		trace.tags.includes("wrong_file") ||
		trace.tags.includes("wrong-file")
	) {
		applyTextMatch("wrong_file", 3);
	}

	if (fallback && out.unknown.citations.length === 0) {
		out.unknown.citations.push({ type: fallback.type, hash: fallback.hash });
	}

	return out;
}

function confidence(score: number) {
	const raw = Math.min(0.95, 0.35 + score * 0.12);
	return Number(raw.toFixed(2));
}

function pathsFromRecord(record: FailureRecord, tracePaths: string[]) {
	const fromEvidence = (record.evidence ?? [])
		.flatMap((item) =>
			Array.from(
				item.redactedText.matchAll(/(?:^|\s)([\w./-]+\.[\w-]+)(?:\s|$)/g),
			).map((match) => match[1]),
		)
		.filter((value) => value.length <= 120 && !value.includes("[REDACTED]"));
	return Array.from(new Set([...tracePaths, ...fromEvidence])).slice(0, 5);
}

function toolsFromRecord(record: FailureRecord) {
	const out = (record.evidence ?? [])
		.flatMap((item) =>
			Array.from(
				item.redactedText.matchAll(
					/-\s+([\w./:-]+):\s+(?:error|completed|running|failed)/gi,
				),
			).map((m) => m[1]?.toLowerCase() ?? ""),
		)
		.filter((value) => value.length > 0);
	return Array.from(new Set(out)).slice(0, 5);
}

function buildMatch(record: FailureRecord, keywords: readonly string[]) {
	const trace = safeTrace(record);
	const signatures = [
		record.signature.messageHash,
		record.signature.toolFailureHash,
	].filter((value): value is string => Boolean(value));
	const match: GuardrailMatch = {
		signatures,
		tools: toolsFromRecord(record),
		paths: pathsFromRecord(record, trace.paths),
		keywords: [...keywords],
	};
	return Object.fromEntries(
		Object.entries(match).filter(
			(entry) => Array.isArray(entry[1]) && entry[1].length > 0,
		),
	) as GuardrailMatch;
}

export function buildDeterministicAnalysis(record: FailureRecord): WhyFailedAnalysis {
	const signals = collect(record);
	const ranked = FailureOrder.map((type) => signals[type])
		.filter((signal) => signal.score > 0)
		.sort((a, b) => {
			if (a.score !== b.score) return b.score - a.score;
			return FailureOrder.indexOf(a.type) - FailureOrder.indexOf(b.type);
		});

	const top = (ranked.length > 0 ? ranked : [signals.unknown]).slice(0, 3);
	const hierarchy = [
		...top.map((signal) => signal.type),
		...FailureOrder.filter(
			(type) =>
				!top.some((signal) => signal.type === type) && signals[type].score > 0,
		),
	].slice(0, 5);

	const hypotheses = top.map((signal) => {
		return {
			type: signal.type,
			confidence: confidence(signal.score),
			explanation: Explanations[signal.type],
			citations: dedupeCitations(signal.citations, 3),
		} satisfies WhyFailedHypothesis;
	});

	const ruleTypes = [
		...new Set([...top.map((signal) => signal.type), "unknown"]),
	] as Array<WhyFailedHypothesis["type"]>;
	const rules = ruleTypes.slice(0, 3).map((type) => {
		const template = RuleTemplates[type];
		return {
			text: template.text.slice(0, 160),
			severity: template.severity,
			match: buildMatch(record, template.keywords),
		} satisfies WhyFailedRuleSuggestion;
	});

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		hierarchy,
		hypotheses,
		rules,
	};
}
