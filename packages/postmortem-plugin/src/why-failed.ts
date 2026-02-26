import { z } from "zod";
import { buildDeterministicAnalysis } from "./analysis";
import type { FailureRecord, WhyFailedAnalysis } from "./model";
import { resolvePostmortemRoot } from "./storage/paths";
import { loadFailureRecords, updateFailureRecord } from "./store/failures";
import { storePathsFromRoot } from "./store/paths";

const WhyFailedArgsSchema = z.object({
	id: z.string().optional(),
	latest: z.boolean().optional(),
	json: z.boolean().optional(),
});

type WhyFailedArgs = z.infer<typeof WhyFailedArgsSchema>;

function parseDate(value: string) {
	const time = Date.parse(value);
	if (Number.isNaN(time)) return 0;
	return time;
}

function sortRecords(records: Array<FailureRecord>) {
	return [...records].sort((a, b) => {
		const diff = parseDate(b.createdAt) - parseDate(a.createdAt);
		if (diff !== 0) return diff;
		return a.id.localeCompare(b.id);
	});
}

function renderText(payload: {
	id: string;
	hierarchy: WhyFailedAnalysis["hierarchy"];
	hypotheses: WhyFailedAnalysis["hypotheses"];
	rules: WhyFailedAnalysis["rules"];
	root: string;
	failuresPath: string;
	summaryPath: string;
}) {
	return [
		`why-failed updated: ${payload.id}`,
		`hierarchy: ${payload.hierarchy.join(" > ")}`,
		...payload.hypotheses.map(
			(item, index) =>
				`hypothesis ${index + 1}: ${item.type} confidence=${item.confidence} citations=${item.citations
					.map((citation) => `${citation.type}:${citation.hash}`)
					.join(",")}`,
		),
		...payload.rules.map(
			(item, index) =>
				`rule ${index + 1}: [${item.severity}] ${item.text} match=${JSON.stringify(item.match)}`,
		),
		`storage root: ${payload.root}`,
		`files: failures=${payload.failuresPath} summary=${payload.summaryPath}`,
	].join("\n");
}

export async function renderWhyFailed(
	worktree: string,
	rawArgs: WhyFailedArgs = {},
) {
	const parsed = WhyFailedArgsSchema.safeParse(rawArgs);
	const roots = await resolvePostmortemRoot(worktree);
	const root = roots.root;
	const store = storePathsFromRoot(root);

	if (!parsed.success) {
		const payload = {
			ok: false,
			error: parsed.error.issues[0]?.message ?? "invalid arguments",
			storageRoot: root,
		};
		if (rawArgs.json) return JSON.stringify(payload);
		return `${payload.error}\nstorage root: ${root}`;
	}

	const args = parsed.data;
	const json = Boolean(args.json);
	const loaded = await loadFailureRecords(root);
	if (loaded.records.length === 0) {
		const payload = {
			ok: false,
			error: "no failure records found",
			storageRoot: root,
		};
		if (json) return JSON.stringify(payload);
		return `${payload.error}\nstorage root: ${root}`;
	}

	const target = args.id
		? loaded.records.find((record) => record.id === args.id)
		: sortRecords(loaded.records)[0];

	if (!target) {
		const payload = {
			ok: false,
			error: `record not found: ${args.id}`,
			storageRoot: root,
		};
		if (json) return JSON.stringify(payload);
		return `${payload.error}\nstorage root: ${root}`;
	}

	if (!args.id && args.latest === false) {
		const payload = {
			ok: false,
			error: "set id or latest=true",
			storageRoot: root,
		};
		if (json) return JSON.stringify(payload);
		return `${payload.error}\nstorage root: ${root}`;
	}

	const analysis = buildDeterministicAnalysis(target);
	const updated = await updateFailureRecord(root, target.id, (record) => ({
		...record,
		analysis,
	}));

	if (updated.notFound || !updated.updated) {
		const payload = {
			ok: false,
			error: `record disappeared during update: ${target.id}`,
			storageRoot: root,
			warnings: updated.warnings,
		};
		if (json) return JSON.stringify(payload);
		return `${payload.error}\nstorage root: ${root}`;
	}

	const payload = {
		ok: true,
		id: target.id,
		storageRoot: root,
		failuresPath: store.failures,
		summaryPath: store.summary,
		hierarchy: analysis.hierarchy,
		hypotheses: analysis.hypotheses,
		rules: analysis.rules,
		skipped: updated.skipped,
		warnings: updated.warnings,
	};
	if (json) return JSON.stringify(payload);
	return renderText({
		id: target.id,
		hierarchy: analysis.hierarchy,
		hypotheses: analysis.hypotheses,
		rules: analysis.rules,
		root,
		failuresPath: store.failures,
		summaryPath: store.summary,
	});
}

export type { WhyFailedArgs };
