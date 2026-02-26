import { z } from "zod";
export const MAX_REDACTED_TEXT = 2000;
export const MAX_RULE_TEXT = 160;
export const MAX_SIGNATURES = 10;
export const MAX_PATHS = 50;
export const MAX_TOOLS = 20;
export const FAILURE_RECORD_SCHEMA_VERSION = 1;

export const EvidenceType = z.enum([
	"tool",
	"error",
	"diff_summary",
	"git_status",
	"context_gap",
]);

export const EvidenceItem = z.object({
	type: EvidenceType,
	redactedText: z.string().max(MAX_REDACTED_TEXT),
	hash: z.string(),
	byteCount: z.number().int().nonnegative(),
	tokenEstimate: z.number().int().nonnegative(),
});

export const Signature = z.object({
	messageHash: z.string(),
	toolFailureHash: z.string().optional(),
});

export const GuardrailMatch = z.object({
	signatures: z.array(z.string()).max(MAX_SIGNATURES).optional(),
	paths: z.array(z.string()).max(MAX_PATHS).optional(),
	tools: z.array(z.string()).max(MAX_TOOLS).optional(),
	keywords: z.array(z.string()).optional(),
});

export const GuardrailRule = z.object({
	id: z.string(),
	enabled: z.boolean(),
	match: GuardrailMatch,
	rule: z.object({
		text: z.string().max(MAX_RULE_TEXT),
		severity: z.enum(["must", "should"]),
	}),
	userFeedbackRating: z.enum(["positive", "negative"]).optional(),
	userFeedbackNote: z.string().max(500).optional(),
});

export const FailureKind = z.enum([
	"missing_env",
	"missing_file",
	"test_failure",
	"wrong_file",
	"unknown",
]);

export const WhyFailedCitation = z.object({
	type: EvidenceType,
	hash: z.string(),
});

export const WhyFailedHypothesis = z.object({
	type: FailureKind,
	confidence: z.number().min(0).max(1),
	explanation: z.string().max(300),
	citations: z.array(WhyFailedCitation).min(1).max(5),
});

export const WhyFailedRuleSuggestion = z.object({
	text: z.string().max(MAX_RULE_TEXT),
	severity: z.enum(["must", "should"]),
	match: GuardrailMatch,
});

export const WhyFailedAnalysis = z.object({
	version: z.literal(1),
	generatedAt: z.string(),
	hierarchy: z.array(FailureKind).min(1).max(5),
	hypotheses: z.array(WhyFailedHypothesis).min(1).max(3),
	rules: z.array(WhyFailedRuleSuggestion).min(1).max(3),
});

export const FailureRecord = z.object({
	schemaVersion: z.literal(FAILURE_RECORD_SCHEMA_VERSION),
	id: z.string(),
	projectId: z.string(),
	createdAt: z.string(),
	sessionId: z.string(),
	parentFailureId: z.string().optional(),
	runId: z.string().optional(),
	signature: Signature,
	evidence: z.array(EvidenceItem).optional(),
	redactionReport: z.unknown().optional(),
	selectionTrace: z.unknown().optional(),
	analysis: WhyFailedAnalysis.optional(),
});

export type EvidenceItem = z.infer<typeof EvidenceItem>;
export type GuardrailMatch = z.infer<typeof GuardrailMatch>;
export type GuardrailRule = z.infer<typeof GuardrailRule>;
export type FailureRecord = z.infer<typeof FailureRecord>;
export type WhyFailedCitation = z.infer<typeof WhyFailedCitation>;
export type WhyFailedHypothesis = z.infer<typeof WhyFailedHypothesis>;
export type WhyFailedRuleSuggestion = z.infer<typeof WhyFailedRuleSuggestion>;
export type WhyFailedAnalysis = z.infer<typeof WhyFailedAnalysis>;

export const FailureRecordPartial = FailureRecord.partial();

export default {
	EvidenceItem,
	GuardrailRule,
	FailureRecord,
};
