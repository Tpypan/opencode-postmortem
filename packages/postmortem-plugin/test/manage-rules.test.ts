import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { renderManageRules } from "../src/manage-rules"
import { FAILURE_RECORD_SCHEMA_VERSION, type FailureRecord, type WhyFailedRuleSuggestion } from "../src/model"
import { postmortemPaths } from "../src/storage/paths"
import { appendFailureRecord } from "../src/store/failures"
import { storePathsFromRoot } from "../src/store/paths"
import { loadRules, saveRules } from "../src/store/rules"

const dirs: string[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function failureFixture(id: string, rules: WhyFailedRuleSuggestion[]): FailureRecord {
  return {
    schemaVersion: FAILURE_RECORD_SCHEMA_VERSION,
    id,
    projectId: "proj_test",
    createdAt: "2026-02-26T00:00:00.000Z",
    sessionId: "session_a",
    signature: {
      messageHash: `msg_${id}`,
      toolFailureHash: `tool_${id}`,
    },
    evidence: [
      {
        type: "error",
        redactedText: "ENOENT: no such file or directory",
        hash: `hash_${id}`,
        byteCount: 31,
        tokenEstimate: 8,
      },
    ],
    analysis: {
      version: 1,
      generatedAt: "2026-02-26T00:00:00.000Z",
      hierarchy: ["missing_file"],
      hypotheses: [
        {
          type: "missing_file",
          confidence: 0.9,
          explanation: "missing path",
          citations: [
            {
              type: "error",
              hash: `hash_${id}`,
            },
          ],
        },
      ],
      rules,
    },
  }
}

function suggestions(prefix: string): WhyFailedRuleSuggestion[] {
  return [
    {
      text: `Ensure ${prefix} file exists before execution`,
      severity: "must",
      match: {
        keywords: ["ENOENT", prefix],
      },
    },
    {
      text: `Log missing ${prefix} path in failures`,
      severity: "should",
      match: {
        paths: [`src/${prefix}.ts`],
      },
    },
  ]
}

async function setup(name: string, records: FailureRecord[]) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `postmortem-manage-rules-${name}-`))
  dirs.push(worktree)
  const paths = await postmortemPaths(worktree)
  roots.push(paths.defaultRoot)
  await fs.mkdir(paths.defaultRoot, { recursive: true })
  for (const record of records) {
    await appendFailureRecord(paths.defaultRoot, record)
  }
  return {
    worktree,
    root: paths.defaultRoot,
  }
}

describe("manage-rules", () => {
  test("list returns empty by default", async () => {
    const setupData = await setup("list-empty", [])
    const out = await renderManageRules(setupData.worktree, { action: "list", json: true })
    const payload = JSON.parse(out)

    expect(payload.ok).toBe(true)
    expect(payload.count).toBe(0)
    expect(payload.rules).toEqual([])
  })

  test("add_from_failure imports analysis rules", async () => {
    const setupData = await setup("add", [failureFixture("f_add", suggestions("alpha"))])

    const out = await renderManageRules(setupData.worktree, {
      action: "add_from_failure",
      failureId: "f_add",
      json: true,
    })
    const payload = JSON.parse(out)
    const stored = await loadRules(setupData.root)

    expect(payload.ok).toBe(true)
    expect(payload.addedCount).toBe(2)
    expect(stored).toHaveLength(2)
    expect(stored.every((rule) => rule.enabled)).toBe(true)
  })

  test("disable hides rule from list unless includeDisabled=true", async () => {
    const setupData = await setup("disable", [failureFixture("f_disable", suggestions("beta"))])
    await renderManageRules(setupData.worktree, {
      action: "add_from_failure",
      failureId: "f_disable",
      json: true,
    })

    const stored = await loadRules(setupData.root)
    await renderManageRules(setupData.worktree, {
      action: "disable",
      id: stored[0].id,
      json: true,
    })

    const enabledOnly = JSON.parse(await renderManageRules(setupData.worktree, { action: "list", json: true }))
    const allRules = JSON.parse(
      await renderManageRules(setupData.worktree, {
        action: "list",
        includeDisabled: true,
        json: true,
      }),
    )

    expect(enabledOnly.count).toBe(1)
    expect(allRules.count).toBe(2)
    expect(allRules.rules.some((rule: { id: string; enabled: boolean }) => rule.id === stored[0].id && !rule.enabled)).toBe(true)
  })

  test("edit updates rule text", async () => {
    const setupData = await setup("edit", [failureFixture("f_edit", suggestions("gamma"))])
    await renderManageRules(setupData.worktree, {
      action: "add_from_failure",
      failureId: "f_edit",
      json: true,
    })

    const stored = await loadRules(setupData.root)
    const updatedText = "Validate gamma dependencies before execution"
    await renderManageRules(setupData.worktree, {
      action: "edit",
      id: stored[0].id,
      text: updatedText,
      json: true,
    })

    const reloaded = await loadRules(setupData.root)
    expect(reloaded.find((rule) => rule.id === stored[0].id)?.rule.text).toBe(updatedText)
  })

  test("rate persists user feedback fields", async () => {
    const setupData = await setup("rate", [failureFixture("f_rate", suggestions("delta"))])
    await renderManageRules(setupData.worktree, {
      action: "add_from_failure",
      failureId: "f_rate",
      json: true,
    })

    const stored = await loadRules(setupData.root)
    await renderManageRules(setupData.worktree, {
      action: "rate",
      id: stored[0].id,
      rating: "negative",
      note: "too broad for this case",
      json: true,
    })

    const reloaded = await loadRules(setupData.root)
    const rated = reloaded.find((rule) => rule.id === stored[0].id)
    expect(rated?.userFeedbackRating).toBe("negative")
    expect(rated?.userFeedbackNote).toBe("too broad for this case")
  })

  test("saveRules redacts text before writing rules.json", async () => {
    const setupData = await setup("save-redacts", [])
    await saveRules(setupData.root, [
      {
        id: "r-secret",
        enabled: true,
        match: { signatures: ["sig-1"] },
        rule: {
          severity: "must",
          text: "API_TOKEN=supersecretvalue",
        },
      },
    ])

    const raw = await fs.readFile(storePathsFromRoot(setupData.root).rules, "utf8")
    expect(raw).toContain("[REDACTED]")
    expect(raw).not.toContain("supersecretvalue")
  })

  test("list/show redact output even when rules file contains unredacted text", async () => {
    const setupData = await setup("render-redacts", [])
    await fs.writeFile(
      storePathsFromRoot(setupData.root).rules,
      JSON.stringify(
        [
          {
            id: "r-show",
            enabled: true,
            match: { signatures: ["sig-1"] },
            rule: {
              severity: "must",
              text: "API_TOKEN=supersecretvalue",
            },
          },
        ],
        null,
        2,
      ),
      "utf8",
    )

    const listJson = JSON.parse(
      await renderManageRules(setupData.worktree, {
        action: "list",
        json: true,
      }),
    )
    expect(listJson.rules[0]?.text).toContain("[REDACTED]")
    expect(listJson.rules[0]?.text).not.toContain("supersecretvalue")

    const showJson = JSON.parse(
      await renderManageRules(setupData.worktree, {
        action: "show",
        id: "r-show",
        json: true,
      }),
    )
    expect(showJson.rule.rule.text).toContain("[REDACTED]")
    expect(showJson.rule.rule.text).not.toContain("supersecretvalue")

    const showHuman = await renderManageRules(setupData.worktree, {
      action: "show",
      id: "r-show",
    })
    expect(showHuman).toContain("[REDACTED]")
    expect(showHuman).not.toContain("supersecretvalue")
  })
})
