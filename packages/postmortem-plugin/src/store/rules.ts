import fs from "node:fs/promises"
import { z } from "zod"
import { GuardrailRule, type GuardrailRule as GuardrailRuleType } from "../model"
import { redact } from "../redaction"
import { acquireWriteLock } from "../storage/lock"
import { assertSafeArtifactPath } from "../storage/paths"
import { storePathsFromRoot } from "./paths"

const GuardrailRules = z.array(GuardrailRule)

export async function loadRules(root: string): Promise<Array<GuardrailRuleType>> {
  const paths = storePathsFromRoot(root)
  await assertSafeArtifactPath(paths.rules, "read", "rules.json")
  const text = await fs.readFile(paths.rules, "utf8").catch((error) => {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") return ""
    throw err
  })

  if (!text.trim()) return []
  return GuardrailRules.parse(JSON.parse(text))
}

export async function saveRules(root: string, rules: Array<GuardrailRuleType>) {
  const paths = storePathsFromRoot(root)
  const parsed = GuardrailRules.parse(rules)
  const redacted = parsed.map((rule) => ({
    ...rule,
    rule: {
      ...rule.rule,
      text: redact(rule.rule.text).text,
    },
  }))
  await fs.mkdir(paths.root, { recursive: true })
  await assertSafeArtifactPath(paths.rules, "write", "rules.json")
  const lock = await acquireWriteLock(paths.lock)

  try {
    await fs.writeFile(paths.rules, JSON.stringify(redacted, null, 2), "utf8")
  } finally {
    await lock.release()
  }

  return {
    path: paths.rules,
    lockPath: paths.lock,
    count: redacted.length,
  }
}
