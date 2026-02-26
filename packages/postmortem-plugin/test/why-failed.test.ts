import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	FAILURE_RECORD_SCHEMA_VERSION,
	type FailureRecord,
} from "../src/model";
import { postmortemPaths } from "../src/storage/paths";
import { appendFailureRecord, loadFailureRecords } from "../src/store/failures";
import { renderWhyFailed } from "../src/why-failed";

const dirs: string[] = [];
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
	);
	await Promise.all(
		roots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	);
});

function fixture(input: {
	id: string;
	createdAt: string;
	text: string;
	sessionId?: string;
	selectionTrace?: unknown;
}): FailureRecord {
	return {
		schemaVersion: FAILURE_RECORD_SCHEMA_VERSION,
		id: input.id,
		projectId: "proj_test",
		createdAt: input.createdAt,
		sessionId: input.sessionId ?? "session_1",
		signature: {
			messageHash: `msg_${input.id}`,
			toolFailureHash: `tool_${input.id}`,
		},
		evidence: [
			{
				type: "error",
				redactedText: input.text,
				hash: `hash_${input.id}`,
				byteCount: input.text.length,
				tokenEstimate: Math.ceil(input.text.length / 4),
			},
		],
		...(input.selectionTrace ? { selectionTrace: input.selectionTrace } : {}),
	};
}

async function setup(name: string, records: Array<FailureRecord>) {
	const worktree = await fs.mkdtemp(
		path.join(os.tmpdir(), `postmortem-why-failed-${name}-`),
	);
	dirs.push(worktree);
	const paths = await postmortemPaths(worktree);
	roots.push(paths.defaultRoot);
	await fs.mkdir(paths.defaultRoot, { recursive: true });
	for (const record of records) {
		await appendFailureRecord(paths.defaultRoot, record);
	}
	return {
		worktree,
		root: paths.defaultRoot,
	};
}

describe("why-failed", () => {
test("classifies missing_env and persists analysis on the record", async () => {
		const setupData = await setup("env", [
			fixture({
				id: "env-1",
				createdAt: "2026-02-26T00:00:00.000Z",
				text: "Missing required environment variable: API_KEY not set",
			}),
		]);

		const payload = JSON.parse(
			await renderWhyFailed(setupData.worktree, {
				id: "env-1",
				json: true,
			}),
		);
		const reloaded = await loadFailureRecords(setupData.root);
		const summary = await fs.readFile(
			path.join(setupData.root, "SUMMARY.md"),
			"utf8",
		);
		const updated = reloaded.records.find((record) => record.id === "env-1");

		expect(payload.ok).toBe(true);
		expect(payload.hierarchy[0]).toBe("missing_env");
		expect(payload.hypotheses.length).toBeGreaterThanOrEqual(1);
		expect(payload.hypotheses.length).toBeLessThanOrEqual(3);
		expect(payload.rules.length).toBeGreaterThanOrEqual(1);
		expect(payload.rules.length).toBeLessThanOrEqual(3);
		expect(
			payload.rules.every((rule: { text: string }) => rule.text.length <= 160),
		).toBe(true);
		expect(
			payload.rules.every((rule: { severity: string }) =>
				["must", "should"].includes(rule.severity),
			),
		).toBe(true);
		expect(updated?.analysis?.hierarchy[0]).toBe("missing_env");
		expect(summary).toContain("- Total records: 1");
	});

	test("uses selectionTrace.reason and tags to classify missing_env and wrong_file", async () => {
		const setupData = await setup("reason-tags", [
			fixture({
				id: "trace-1",
				createdAt: "2026-02-26T00:00:00.000Z",
				text: "Some ambiguous error with no clear exit code",
				selectionTrace: {
					reason: "Missing required environment variable: DB_PASS",
					tags: ["wrong-file"],
				},
			}),
		]);

		const payload = JSON.parse(
			await renderWhyFailed(setupData.worktree, {
				id: "trace-1",
				json: true,
			}),
		);

		expect(payload.ok).toBe(true);
		// reason contains missing env language -> missing_env should be top
		expect(payload.hierarchy[0]).toBe("missing_env");
		// tags include wrong-file -> wrong_file should appear in hierarchy
		expect(payload.hierarchy).toContain("wrong_file");
	});

	test("supports latest=true selection and updates the newest record", async () => {
		const setupData = await setup("latest", [
			fixture({
				id: "older",
				createdAt: "2026-02-20T00:00:00.000Z",
				text: "AssertionError: expected true to be false",
			}),
			fixture({
				id: "newer",
				createdAt: "2026-02-26T00:00:00.000Z",
				text: "ENOENT: no such file or directory",
			}),
		]);

		const payload = JSON.parse(
			await renderWhyFailed(setupData.worktree, {
				latest: true,
				json: true,
			}),
		);

		expect(payload.ok).toBe(true);
		expect(payload.id).toBe("newer");
		expect(payload.hierarchy[0]).toBe("missing_file");
	});

	test("requires id or latest=true", async () => {
		const setupData = await setup("args", [
			fixture({
				id: "a",
				createdAt: "2026-02-26T00:00:00.000Z",
				text: "FAIL unit test",
			}),
		]);

		const payload = JSON.parse(
			await renderWhyFailed(setupData.worktree, {
				latest: false,
				json: true,
			}),
		);

		expect(payload.ok).toBe(false);
		expect(payload.error).toContain("set id or latest=true");
	});
});
