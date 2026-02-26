import { describe, expect, test } from "bun:test";
import {
	DEFAULT_EVIDENCE_ITEM_BYTES,
	DEFAULT_FAILURE_TOTAL_BYTES,
	DEFAULT_GUARDRAIL_TOKEN_CAP,
	DEFAULT_SNAPSHOT_TOTAL_BYTES,
	enforceCaps,
	enforceEvidenceCaps,
	enforceFailureCaps,
	enforceGuardrailTokenCap,
	enforceSnapshotCaps,
	REDACTED_SENTINEL,
	redact,
} from "../src/redaction";

describe("redaction", () => {
	test("removes common secrets and reports matched patterns", () => {
		const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const pat = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
		const aws = "AKIA1234567890ABCDEF";
		const entropy = "wK7n8mP2rT9qL4xV6bC1dF3hJ5kN7pQ2";
		const input = [
			"API_KEY=my-real-key",
			'{"apiKey":"value-1","token":"value-2"}',
			"Authorization: Bearer super-secret",
			token,
			pat,
			aws,
			entropy,
		].join("\n");

		const result = redact(input);

		expect(result.text).not.toContain("my-real-key");
		expect(result.text).not.toContain("value-1");
		expect(result.text).not.toContain("value-2");
		expect(result.text).not.toContain("super-secret");
		expect(result.text).not.toContain(token);
		expect(result.text).not.toContain(pat);
		expect(result.text).not.toContain(aws);
		expect(result.text).not.toContain(entropy);
		expect(result.text).toContain(REDACTED_SENTINEL);
		expect(result.report.totalReplacements).toBeGreaterThanOrEqual(7);
		expect(result.report.patterns.env_assignment).toBe(1);
		expect(result.report.patterns.json_secret_key).toBe(2);
		expect(result.report.patterns.authorization_header).toBe(1);
		expect(result.report.patterns.github_token_ghp).toBe(1);
		expect(result.report.patterns.github_token_pat).toBe(1);
		expect(result.report.patterns.aws_access_key_id).toBe(1);
		expect(result.report.patterns.high_entropy_fallback).toBe(1);
		expect(result.report.droppedDueToCaps).toBeFalse();
	});

	test("redacts an entire PEM private key block", () => {
		const pem = [
			"prefix",
			"-----BEGIN PRIVATE KEY-----",
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
			"aKfQ7s2xJmS8Q2qf8k3M4n5P6x7Y8z9W",
			"-----END PRIVATE KEY-----",
			"suffix",
		].join("\n");

		const result = redact(pem);

		expect(result.text).toContain("prefix");
		expect(result.text).toContain("suffix");
		expect(result.text).not.toContain("BEGIN PRIVATE KEY");
		expect(result.text).not.toContain("END PRIVATE KEY");
		expect(result.text).toContain(REDACTED_SENTINEL);
		expect(result.report.patterns.pem_private_key).toBe(1);
	});

	test("sets droppedDueToCaps when redact output is byte-capped", () => {
		const result = redact("x".repeat(100), { maxBytes: 10 });

		expect(result.text.length).toBe(10);
		expect(result.report.droppedDueToCaps).toBeTrue();
	});
});

describe("caps", () => {
	test("truncates per-item and drops over total deterministically", () => {
		const result = enforceCaps(["1234567890", "abcdefghij", "zzzz"], {
			perItemBytes: 8,
			totalBytes: 15,
		});

		expect(result.items).toEqual(["12345678", "abcdefg"]);
		expect(result.report.droppedDueToCaps).toBeTrue();
		expect(result.report.truncatedItems).toBe(3);
		expect(result.report.droppedItems).toBe(1);
		expect(result.report.bytesIn).toBe(24);
		expect(result.report.bytesOut).toBe(15);
	});

	test("wrapper helpers use defaults and return bounded outputs", () => {
		const big = "x".repeat(DEFAULT_EVIDENCE_ITEM_BYTES + 5);
		const evidence = enforceEvidenceCaps([big]);
		const snapshot = enforceSnapshotCaps([
			"a".repeat(DEFAULT_SNAPSHOT_TOTAL_BYTES + 1),
		]);
		const failure = enforceFailureCaps([
			"b".repeat(DEFAULT_FAILURE_TOTAL_BYTES + 1),
		]);

		expect(evidence.items[0].length).toBe(DEFAULT_EVIDENCE_ITEM_BYTES);
		expect(snapshot.items[0].length).toBe(DEFAULT_SNAPSHOT_TOTAL_BYTES);
		expect(failure.items[0].length).toBe(DEFAULT_FAILURE_TOTAL_BYTES);
		expect(evidence.report.droppedDueToCaps).toBeTrue();
		expect(snapshot.report.droppedDueToCaps).toBeTrue();
		expect(failure.report.droppedDueToCaps).toBeTrue();
	});

	test("guardrail token cap enforces token budget", () => {
		const text = "y".repeat(DEFAULT_GUARDRAIL_TOKEN_CAP * 4 + 40);
		const result = enforceGuardrailTokenCap(text);

		expect(result.report.tokenEstimateIn).toBeGreaterThan(
			DEFAULT_GUARDRAIL_TOKEN_CAP,
		);
		expect(result.report.tokenEstimateOut).toBeLessThanOrEqual(
			DEFAULT_GUARDRAIL_TOKEN_CAP,
		);
		expect(result.report.droppedDueToCaps).toBeTrue();
	});
});
