import fs from "node:fs/promises";
import {
	FailureRecord,
	type FailureRecord as FailureRecordType,
} from "../model";
import { acquireWriteLock } from "../storage/lock";
import { assertSafeArtifactPath } from "../storage/paths";
import { storePathsFromRoot } from "./paths";
import { writeSummary } from "./summary";

export type FailureLoadWarning = {
	line: number;
	message: string;
};

export type FailureLoadResult = {
	records: Array<FailureRecordType>;
	skipped: number;
	warnings: Array<FailureLoadWarning>;
};

export type FailureUpdateResult = {
	updated?: FailureRecordType;
	notFound: boolean;
	records: number;
	skipped: number;
	warnings: Array<FailureLoadWarning>;
};

function parseFailureLines(text: string): FailureLoadResult {
	if (!text) {
		return {
			records: [],
			skipped: 0,
			warnings: [],
		};
	}

	const lines = text.split("\n");
	const records: Array<FailureRecordType> = [];
	const warnings: Array<FailureLoadWarning> = [];

	lines.forEach((line, index) => {
		if (line.length === 0) return;

		try {
			const item = FailureRecord.parse(JSON.parse(line));
			records.push(item);
		} catch {
			warnings.push({
				line: index + 1,
				message: "skipped corrupted or invalid failure record",
			});
		}
	});

	return {
		records,
		skipped: warnings.length,
		warnings,
	};
}

async function writeFailureRecords(
	path: string,
	records: Array<FailureRecordType>,
) {
	await assertSafeArtifactPath(path, "write", "failures.jsonl");
	const lines = records.map((record) => JSON.stringify(record)).join("\n");
	await fs.writeFile(path, lines.length > 0 ? `${lines}\n` : "", "utf8");
}

export async function appendFailureRecord(
	root: string,
	record: FailureRecordType,
) {
	const paths = storePathsFromRoot(root);
	const parsed = FailureRecord.parse(record);
	await fs.mkdir(paths.root, { recursive: true });
	await assertSafeArtifactPath(paths.failures, "append", "failures.jsonl");
	const lock = await acquireWriteLock(paths.lock);

	try {
		await fs.appendFile(paths.failures, `${JSON.stringify(parsed)}\n`, "utf8");
	} finally {
		await lock.release();
	}

	return {
		path: paths.failures,
		lockPath: paths.lock,
	};
}

export async function loadFailureRecords(
	root: string,
): Promise<FailureLoadResult> {
	const paths = storePathsFromRoot(root);
	await assertSafeArtifactPath(paths.failures, "read", "failures.jsonl");
	const text = await fs.readFile(paths.failures, "utf8").catch((error) => {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return "";
		throw err;
	});

	return parseFailureLines(text);
}

export async function updateFailureRecord(
	root: string,
	id: string,
	update: (record: FailureRecordType) => FailureRecordType,
): Promise<FailureUpdateResult> {
	const paths = storePathsFromRoot(root);
	await fs.mkdir(paths.root, { recursive: true });
	await assertSafeArtifactPath(paths.failures, "read", "failures.jsonl");
	const lock = await acquireWriteLock(paths.lock);

	let result: FailureUpdateResult;

	try {
		const text = await fs.readFile(paths.failures, "utf8").catch((error) => {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") return "";
			throw err;
		});
		const loaded = parseFailureLines(text);
		const index = loaded.records.findIndex((record) => record.id === id);
		if (index < 0) {
			result = {
				notFound: true,
				records: loaded.records.length,
				skipped: loaded.skipped,
				warnings: loaded.warnings,
			};
		} else {
			const next = FailureRecord.parse(
				update(loaded.records[index] as FailureRecordType),
			);
			loaded.records.splice(index, 1, next);
			await writeFailureRecords(paths.failures, loaded.records);
			result = {
				updated: next,
				notFound: false,
				records: loaded.records.length,
				skipped: loaded.skipped,
				warnings: loaded.warnings,
			};
		}
	} finally {
		await lock.release();
	}

	if (!result.notFound)
		await writeSummary(root, (await loadFailureRecords(root)).records);
	return result;
}

export type PruneOptions = {
	nowIso?: string;
	nowMs?: number;
	maxAgeDays?: number;
	// prefer keepLastN, but support legacy maxRecords
	keepLastN?: number;
	maxRecords?: number;
	maxBytes?: number;
};

export function pruneFailureRecords(
	records: Array<FailureRecordType>,
	options: PruneOptions = {},
) {
	const nowMs =
		options.nowMs ?? (options.nowIso ? Date.parse(options.nowIso) : Date.now());

	// comparator and sort newest first by createdAt, then by id (lexicographic) to be deterministic
	const cmp = (a: FailureRecordType, b: FailureRecordType) => {
		const ta = Date.parse(a.createdAt);
		const tb = Date.parse(b.createdAt);
		if (ta !== tb) return tb - ta;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	};
	const sorted = [...records].sort(cmp);

	const dropped: Array<FailureRecordType> = [];

	// age-based pruning
	let kept = sorted;
	if (typeof options.maxAgeDays === "number") {
		const cutoff = nowMs - options.maxAgeDays * 24 * 60 * 60 * 1000;
		const pass: Array<FailureRecordType> = [];
		for (const r of kept) {
			const t = Date.parse(r.createdAt);
			if (t >= cutoff) pass.push(r);
			else dropped.push(r);
		}
		kept = pass;
	}

	// count-based pruning
	const keepN =
		typeof options.keepLastN === "number"
			? options.keepLastN
			: options.maxRecords;
	if (typeof keepN === "number" && kept.length > keepN) {
		const toDrop = kept.slice(keepN);
		dropped.push(...toDrop);
		kept = kept.slice(0, keepN);
	}

	// size-based pruning (byte length of JSONL line)
	if (typeof options.maxBytes === "number") {
		const sizes = kept.map((r) =>
			Buffer.byteLength(`${JSON.stringify(r)}\n`, "utf8"),
		);
		let total = sizes.reduce((s, n) => s + n, 0);
		// drop oldest (end of array) until under limit
		while (total > options.maxBytes && kept.length > 0) {
			const removed = kept.pop() as FailureRecordType;
			const sz = sizes.pop() as number;
			total -= sz;
			dropped.push(removed);
		}
	}

	// ensure dropped is also deterministic: newest-first
	dropped.sort(cmp);
	return { kept, dropped };
}
