import { type Plugin, tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { createGuardrailSystemTransform } from "./injection";
import { type InspectArgs, renderInspect } from "./inspect";
import {
	type ManageFailuresArgs,
	renderManageFailures,
} from "./manage-failures";
import { type ManageRulesArgs, renderManageRules } from "./manage-rules";
import { type RecordFailureArgs, renderRecordFailure } from "./record-failure";
import { createRetryRenderer, type RetryArgs } from "./retry";
import { buildLastRunMarkdown, buildLastRunSnapshot } from "./snapshot/build";
import { writeLastRunSnapshot } from "./snapshot/write";
import {
	loadPostmortemConfig,
	postmortemConfigPath,
	repoStorageSafety,
	resolvePostmortemRoot,
	savePostmortemConfig,
} from "./storage/paths";
import { renderWhyFailed, type WhyFailedArgs } from "./why-failed";

export * from "./redaction";
export * from "./snapshot/model";

const MAX_GIT_STATUS_LINES = 400;

type DisableLessonsArgs = {
	disable?: boolean;
	enable?: boolean;
	json?: boolean;
};

const PostmortemConfigArgsSchema = z.object({
	action: z.enum(["show", "set"]).optional(),
	storage: z.enum(["user", "repo"]).optional(),
	storeRaw: z.boolean().optional(),
	json: z.boolean().optional(),
});

type PostmortemConfigArgs = z.infer<typeof PostmortemConfigArgsSchema>;

async function renderPostmortemConfig(
	worktree: string,
	rawArgs: PostmortemConfigArgs = {},
) {
	const parsed = PostmortemConfigArgsSchema.safeParse(rawArgs);
	if (!parsed.success) {
		const payload = {
			ok: false,
			error: parsed.error.issues[0]?.message ?? "invalid arguments",
			configPath: postmortemConfigPath(worktree),
		};
		if (rawArgs.json) return JSON.stringify(payload);
		return `${payload.error}\nconfig path: ${payload.configPath}`;
	}

	const args = parsed.data;
	const action = args.action ?? "show";
	const json = Boolean(args.json);

	if (action === "set" && args.storage === undefined && args.storeRaw === undefined) {
		const payload = {
			ok: false,
			error: "action set requires storage=user|repo and/or storeRaw=true|false",
			configPath: postmortemConfigPath(worktree),
		};
		if (json) return JSON.stringify(payload);
		return `${payload.error}\nconfig path: ${payload.configPath}`;
	}

	if (action === "set") {
		if (args.storage === "repo") {
			const safety = await repoStorageSafety(worktree);
			if (!safety.safe) {
				const payload = {
					ok: false,
					error: safety.error,
					configPath: postmortemConfigPath(worktree),
				};
				if (json) return JSON.stringify(payload);
				return `${payload.error}\nconfig path: ${payload.configPath}`;
			}
		}

		const current = await loadPostmortemConfig(worktree);
		await savePostmortemConfig(worktree, {
			storage: args.storage ?? current.storage,
			storeRaw: args.storeRaw ?? current.storeRaw,
		});
	}

	const [config, roots] = await Promise.all([
		loadPostmortemConfig(worktree),
		resolvePostmortemRoot(worktree),
	]);

	const payload = {
		ok: true,
		action,
		projectId: roots.projectId,
		configPath: postmortemConfigPath(worktree),
		config,
		storage: config.storage ?? "user",
		storeRaw: config.storeRaw ?? false,
		root: roots.root,
		defaultRoot: roots.defaultRoot,
		localOverrideRoot: roots.localOverrideRoot,
	};
	if (json) return JSON.stringify(payload);
	return [
		`action: ${payload.action}`,
		`storage: ${payload.storage}`,
		`store raw: ${payload.storeRaw}`,
		`project: ${payload.projectId}`,
		`root: ${payload.root}`,
		`default root: ${payload.defaultRoot}`,
		`repo root: ${payload.localOverrideRoot}`,
		`config path: ${payload.configPath}`,
	].join("\n");
}

async function readGitStatus(worktree: string, $: Parameters<Plugin>[0]["$"]) {
	const inside = await $`git -C ${worktree} rev-parse --is-inside-work-tree`
		.nothrow()
		.quiet();
	if (inside.exitCode !== 0) return undefined;

	const result =
		await $`git -C ${worktree} status --porcelain=v1 --untracked-files=normal`
			.nothrow()
			.quiet();
	if (result.exitCode !== 0) return undefined;

	const lines = (await result.text())
		.split(/\r?\n/)
		.filter((line) => line.length > 0);

	return {
		lines: lines.slice(0, MAX_GIT_STATUS_LINES),
		truncated: lines.length > MAX_GIT_STATUS_LINES,
	};
}

export const postmortemPlugin: Plugin = async (input) => {
	const disabledLessons = new Set<string>();
	const systemTransform = createGuardrailSystemTransform(
		input.worktree,
		{},
		(sessionID) => disabledLessons.has(sessionID),
	);
	const renderRetry = createRetryRenderer();

	return {
		event: async ({ event }) => {
			if (event.type !== "session.idle") return;

			const [paths, config] = await Promise.all([
				resolvePostmortemRoot(input.worktree).catch(() => undefined),
				loadPostmortemConfig(input.worktree).catch(() => ({ storeRaw: false })),
			]);
			if (!paths) return;

			const sessionID = event.properties.sessionID;
			const [messagesResult, diffResult, gitStatus] = await Promise.all([
				input.client.session
					.messages({ path: { id: sessionID } })
					.catch(() => undefined),
				input.client.session
					.diff({ path: { id: sessionID } })
					.catch(() => undefined),
				readGitStatus(input.worktree, input.$).catch(() => undefined),
			]);

			const snapshotInput = {
				projectId: paths.projectId,
				sessionID,
				messages: messagesResult?.data ?? [],
				diffs: diffResult?.data ?? [],
				gitStatusLines: gitStatus?.lines,
				gitStatusTruncated: gitStatus?.truncated,
			};
			const snapshot = buildLastRunSnapshot(snapshotInput);
			const rawSnapshot = config.storeRaw
				? buildLastRunSnapshot(snapshotInput, { redact: false })
				: undefined;

			const markdown = buildLastRunMarkdown(snapshot);
			await writeLastRunSnapshot({
				worktree: input.worktree,
				snapshot,
				rawSnapshot,
				markdown,
			}).catch(() => undefined);
		},
		tool: {
			postmortem_config: tool({
				description:
					"Show or set project-local postmortem storage config (user or repo root)",
				args: {
					action: tool.schema.string().optional(),
					storage: tool.schema.string().optional(),
					storeRaw: tool.schema.boolean().optional(),
					json: tool.schema.boolean().optional(),
				},
				async execute(args: PostmortemConfigArgs, ctx) {
					return renderPostmortemConfig(ctx.worktree, args);
				},
			}),
			postmortem_disable_lessons: tool({
				description:
					"Disable or re-enable postmortem guardrail injection for this session",
				args: {
					disable: tool.schema.boolean().optional(),
					enable: tool.schema.boolean().optional(),
					json: tool.schema.boolean().optional(),
				},
				async execute(args: DisableLessonsArgs, ctx) {
					if (!ctx.sessionID) {
						const payload = {
							ok: false,
							error: "sessionID is required",
							action: "none",
							disabled: false,
						};
						if (args.json) return JSON.stringify(payload);
						return payload.error;
					}

					if (args.disable && args.enable) {
						const payload = {
							ok: false,
							error: "choose only one of --disable or --enable",
							action: "none",
							sessionID: ctx.sessionID,
							disabled: disabledLessons.has(ctx.sessionID),
						};
						if (args.json) return JSON.stringify(payload);
						return payload.error;
					}

					const action = args.enable ? "enable" : "disable";
					if (action === "enable") {
						disabledLessons.delete(ctx.sessionID);
					} else {
						disabledLessons.add(ctx.sessionID);
					}

					const disabled = disabledLessons.has(ctx.sessionID);
					const payload = {
						ok: true,
						action,
						sessionID: ctx.sessionID,
						disabled,
					};
					if (args.json) return JSON.stringify(payload);
					return disabled
						? `guardrail lessons disabled for session ${ctx.sessionID}`
						: `guardrail lessons enabled for session ${ctx.sessionID}`;
				},
			}),
			postmortem_retry: tool({
				description:
					"Preview or emit a guardrailed retry prompt from the latest non-command user task",
				args: {
					yes: tool.schema.boolean().optional(),
					explain: tool.schema.boolean().optional(),
					skip: tool.schema.array(tool.schema.string()).optional(),
					json: tool.schema.boolean().optional(),
				},
				async execute(args: RetryArgs, ctx) {
					return renderRetry(ctx.worktree, input.client, ctx.sessionID, args);
				},
			}),
			postmortem_why_failed: tool({
				description:
					"Analyze a stored failure deterministically and persist typed hypotheses + prevention rules",
				args: {
					id: tool.schema.string().optional(),
					latest: tool.schema.boolean().optional(),
					json: tool.schema.boolean().optional(),
				},
				async execute(args: WhyFailedArgs, ctx) {
					return renderWhyFailed(ctx.worktree, args);
				},
			}),
			postmortem_inspect: tool({
				description: "Render last-run postmortem snapshot (safe by default)",
				args: {
					json: tool.schema.boolean().optional(),
					files: tool.schema.boolean().optional(),
					git: tool.schema.boolean().optional(),
					errors: tool.schema.boolean().optional(),
				},
				async execute(args: InspectArgs, ctx) {
					return renderInspect(ctx.worktree, args);
				},
			}),
			postmortem_record_failure: tool({
				description:
					"Preview or persist a durable failure record from last-run snapshot",
				args: {
					yes: tool.schema.boolean().optional(),
					json: tool.schema.boolean().optional(),
					reason: tool.schema.string().optional(),
					tags: tool.schema.array(tool.schema.string()).optional(),
				},
				async execute(args: RecordFailureArgs, ctx) {
					return renderRecordFailure(ctx.worktree, args);
				},
			}),
			postmortem_failures: tool({
				description:
					"List/show/forget/delete/prune/purge stored postmortem failures",
				args: {
					action: tool.schema.string().optional(),
					id: tool.schema.string().optional(),
					sessionId: tool.schema.string().optional(),
					json: tool.schema.boolean().optional(),
					yes: tool.schema.boolean().optional(),
					dryRun: tool.schema.boolean().optional(),
					maxBytes: tool.schema.number().optional(),
					olderThanDays: tool.schema.number().optional(),
					keepLastN: tool.schema.number().optional(),
				},
				async execute(args: ManageFailuresArgs, ctx) {
					return renderManageFailures(ctx.worktree, args);
				},
			}),
			postmortem_rules: tool({
				description:
					"List/show/enable/disable/edit/rate postmortem rules and import suggestions from failure analysis",
				args: {
					action: tool.schema.string().optional(),
					id: tool.schema.string().optional(),
					failureId: tool.schema.string().optional(),
					json: tool.schema.boolean().optional(),
					includeDisabled: tool.schema.boolean().optional(),
					text: tool.schema.string().optional(),
					severity: tool.schema.string().optional(),
					rating: tool.schema.string().optional(),
					note: tool.schema.string().optional(),
				},
				async execute(args: ManageRulesArgs, ctx) {
					return renderManageRules(ctx.worktree, args);
				},
			}),
			postmortem_eval: tool({
				description: "Local-only evaluation of repeat-failure metrics from stored failures.jsonl",
				args: {
					json: tool.schema.boolean().optional(),
					window: tool.schema.number().optional(),
				},
				async execute(args: { json?: boolean; window?: number }, ctx) {
					const { renderEval } = await import("./eval");
					return renderEval(ctx.worktree, args);
				},
			}),
		},
		"experimental.chat.system.transform": systemTransform,
	};
};

export default postmortemPlugin;
