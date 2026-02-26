import { z } from "zod"
import { GuardrailRule, MAX_RULE_TEXT } from "./model"
import { redact } from "./redaction"
import { resolvePostmortemRoot } from "./storage/paths"
import { loadFailureRecords } from "./store/failures"
import { storePathsFromRoot } from "./store/paths"
import { loadRules, saveRules } from "./store/rules"

const ActionSchema = z.enum([
  "list",
  "show",
  "enable",
  "disable",
  "edit",
  "rate",
  "add_from_failure",
])

export const ManageRulesArgsSchema = z.object({
  action: ActionSchema.optional(),
  id: z.string().optional(),
  failureId: z.string().optional(),
  json: z.boolean().optional(),
  includeDisabled: z.boolean().optional(),
  text: z.string().max(MAX_RULE_TEXT).optional(),
  severity: z.enum(["must", "should"]).optional(),
  rating: z.enum(["positive", "negative"]).optional(),
  note: z.string().max(500).optional(),
})

export type ManageRulesArgs = z.infer<typeof ManageRulesArgsSchema>

function errorPayload(message: string, root: string, rulesPath: string) {
  return {
    ok: false,
    error: message,
    storageRoot: root,
    rulesPath,
  }
}

function listItem(rule: z.infer<typeof GuardrailRule>) {
  return {
    id: rule.id,
    enabled: rule.enabled,
    severity: rule.rule.severity,
    text: redact(rule.rule.text).text,
    hasFeedback: Boolean(rule.userFeedbackRating),
  }
}

function redactedRule(rule: z.infer<typeof GuardrailRule>) {
  return {
    ...rule,
    rule: {
      ...rule.rule,
      text: redact(rule.rule.text).text,
    },
  }
}

function renderHuman(payload: {
  lines: string[]
  root: string
  rulesPath: string
  undo: string
}) {
  return [
    ...payload.lines,
    `storage root: ${payload.root}`,
    `rules: ${payload.rulesPath}`,
    `undo: ${payload.undo}`,
  ].join("\n")
}

function dedupeKey(input: { text: string; match: unknown }) {
  return JSON.stringify({
    text: input.text,
    match: input.match,
  })
}

export async function renderManageRules(worktree: string, rawArgs: ManageRulesArgs = {}) {
  const parsed = ManageRulesArgsSchema.safeParse(rawArgs)
  const roots = await resolvePostmortemRoot(worktree)
  const root = roots.root
  const store = storePathsFromRoot(root)

  if (!parsed.success) {
    const payload = errorPayload(parsed.error.issues[0]?.message ?? "invalid arguments", root, store.rules)
    if (rawArgs.json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      rulesPath: store.rules,
      undo: `fix arguments and retry; to reset storage: rm -rf "${root}"`,
    })
  }

  const args = parsed.data
  const action = args.action ?? "list"
  const json = Boolean(args.json)
  const undoReset = `rm -rf "${root}"`

  if ((action === "show" || action === "enable" || action === "disable" || action === "edit" || action === "rate") && !args.id) {
    const payload = errorPayload(`action ${action} requires id`, root, store.rules)
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      rulesPath: store.rules,
      undo: `retry with --id; full reset: ${undoReset}`,
    })
  }

  if (action === "add_from_failure" && !args.failureId) {
    const payload = errorPayload("action add_from_failure requires failureId", root, store.rules)
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      rulesPath: store.rules,
      undo: `retry with --failureId; full reset: ${undoReset}`,
    })
  }

  if (action === "edit" && !args.text && !args.severity) {
    const payload = errorPayload("action edit requires text or severity", root, store.rules)
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      rulesPath: store.rules,
      undo: `retry with --text or --severity; full reset: ${undoReset}`,
    })
  }

  if (action === "rate" && !args.rating) {
    const payload = errorPayload("action rate requires rating", root, store.rules)
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      rulesPath: store.rules,
      undo: `retry with --rating; full reset: ${undoReset}`,
    })
  }

  if (action === "list") {
    const loaded = await loadRules(root)
    const rules = loaded
      .filter((rule) => (args.includeDisabled ? true : rule.enabled))
      .map((rule) => listItem(rule))
    const payload = {
      ok: true,
      action,
      storageRoot: root,
      rulesPath: store.rules,
      includeDisabled: Boolean(args.includeDisabled),
      count: rules.length,
      rules,
    }
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [
        `rules: ${payload.count}`,
        ...rules.slice(0, 50).map((rule) => `${rule.id} enabled=${rule.enabled} severity=${rule.severity} text=${rule.text}`),
        ...(rules.length > 50 ? ["...truncated..."] : []),
      ],
      root,
      rulesPath: store.rules,
      undo: `list is read-only; to clear all rule state: ${undoReset}`,
    })
  }

  if (action === "show") {
    const loaded = await loadRules(root)
    const rule = loaded.find((item) => item.id === args.id)
    if (!rule) {
      const payload = errorPayload(`rule not found: ${args.id}`, root, store.rules)
      if (json) return JSON.stringify(payload)
      return renderHuman({
        lines: [payload.error],
        root,
        rulesPath: store.rules,
        undo: `check ids with list; full reset: ${undoReset}`,
      })
    }

    const safeRule = redactedRule(rule)
    const payload = {
      ok: true,
      action,
      storageRoot: root,
      rulesPath: store.rules,
      rule: safeRule,
    }
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [
        `rule: ${safeRule.id}`,
        `enabled: ${safeRule.enabled}`,
        `severity: ${safeRule.rule.severity}`,
        `text: ${safeRule.rule.text}`,
        `match: ${JSON.stringify(safeRule.match)}`,
        `feedback: ${safeRule.userFeedbackRating ?? "none"}`,
      ],
      root,
      rulesPath: store.rules,
      undo: `show is read-only; to mutate use enable/disable/edit/rate`,
    })
  }

  if (action === "add_from_failure") {
    const failures = await loadFailureRecords(root)
    const failure = failures.records.find((item) => item.id === args.failureId)
    if (!failure) {
      const payload = errorPayload(`failure not found: ${args.failureId}`, root, store.rules)
      if (json) return JSON.stringify(payload)
      return renderHuman({
        lines: [payload.error],
        root,
        rulesPath: store.rules,
        undo: `check failure ids with postmortem_failures list; full reset: ${undoReset}`,
      })
    }

    if (!failure.analysis) {
      const payload = errorPayload(`failure has no analysis: ${args.failureId}`, root, store.rules)
      if (json) return JSON.stringify(payload)
      return renderHuman({
        lines: [payload.error],
        root,
        rulesPath: store.rules,
        undo: `run postmortem_why_failed first for this failure`,
      })
    }

    const loaded = await loadRules(root)
    const seen = new Set(loaded.map((item) => dedupeKey({ text: item.rule.text, match: item.match })))
    const added: string[] = []
    for (const suggestion of failure.analysis.rules) {
      const key = dedupeKey({ text: suggestion.text, match: suggestion.match })
      if (seen.has(key)) continue
      seen.add(key)
      loaded.push(
        GuardrailRule.parse({
          id: crypto.randomUUID(),
          enabled: true,
          match: suggestion.match,
          rule: {
            text: suggestion.text,
            severity: suggestion.severity,
          },
        }),
      )
      added.push(loaded[loaded.length - 1].id)
    }

    await saveRules(root, loaded)
    const payload = {
      ok: true,
      action,
      storageRoot: root,
      rulesPath: store.rules,
      failureId: args.failureId,
      addedCount: added.length,
      skippedCount: failure.analysis.rules.length - added.length,
      addedIds: added,
      totalRules: loaded.length,
    }
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [
        `added from failure ${args.failureId}: ${payload.addedCount}`,
        `skipped duplicates: ${payload.skippedCount}`,
        ...(added.length > 0 ? [`ids: ${added.join(",")}`] : []),
      ],
      root,
      rulesPath: store.rules,
      undo: `remove added ids via disable/delete workflow or clear all: ${undoReset}`,
    })
  }

  const loaded = await loadRules(root)
  const index = loaded.findIndex((item) => item.id === args.id)
  if (index < 0) {
    const payload = errorPayload(`rule not found: ${args.id}`, root, store.rules)
    if (json) return JSON.stringify(payload)
    return renderHuman({
      lines: [payload.error],
      root,
      rulesPath: store.rules,
      undo: `check ids with list; full reset: ${undoReset}`,
    })
  }

  const current = loaded[index]
  const next =
    action === "enable"
      ? {
          ...current,
          enabled: true,
        }
      : action === "disable"
        ? {
            ...current,
            enabled: false,
          }
        : action === "edit"
          ? {
              ...current,
              rule: {
                ...current.rule,
                ...(args.text ? { text: args.text } : {}),
                ...(args.severity ? { severity: args.severity } : {}),
              },
            }
          : {
              ...current,
              userFeedbackRating: args.rating,
              ...(typeof args.note === "string" ? { userFeedbackNote: args.note } : {}),
            }
  loaded.splice(index, 1, GuardrailRule.parse(next))
  await saveRules(root, loaded)
  const safeRule = redactedRule(loaded[index])

  const payload = {
    ok: true,
    action,
    id: args.id,
    storageRoot: root,
    rulesPath: store.rules,
    rule: safeRule,
  }
  if (json) return JSON.stringify(payload)
  return renderHuman({
    lines: [
      `${action}: ${args.id}`,
      `enabled: ${safeRule.enabled}`,
      `severity: ${safeRule.rule.severity}`,
      `text: ${safeRule.rule.text}`,
      `feedback: ${safeRule.userFeedbackRating ?? "none"}`,
    ],
    root,
    rulesPath: store.rules,
    undo: `state changed; edit ${store.rules} manually to undo or reset all: ${undoReset}`,
  })
}
