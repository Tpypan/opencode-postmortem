import type { GuardrailRule } from "./model"
import { DEFAULT_GUARDRAIL_TOKEN_CAP } from "./redaction"
import type { LastRunSnapshot } from "./snapshot/model"

const NEGATIVE_RATING_PENALTY = 6

export type GuardrailContext = {
  signatures?: string[]
  paths?: string[]
  tools?: string[]
  keywords?: string[]
}

export type MatchCounts = {
  signatures: number
  paths: number
  tools: number
  keywords: number
  total: number
}

export type SelectionDropReason =
  | "disabled"
  | "skip_list"
  | "non_positive_score"
  | "token_cap"

export type SelectionTraceItem = {
  id: string
  score: number
  matchCounts: MatchCounts
  tokenEstimate: number
  selected: boolean
  dropReason?: SelectionDropReason
}

export type SelectGuardrailsInput = {
  rules: GuardrailRule[]
  context: GuardrailContext
  tokenCap?: number
  skipIds?: string[]
}

export type SelectGuardrailsResult = {
  selected: GuardrailRule[]
  selectedIds: string[]
  tokenCap: number
  tokenEstimate: number
  trace: SelectionTraceItem[]
}

function bytes(text: string) {
  return Buffer.byteLength(text, "utf8")
}

function estimateTokens(text: string) {
  return Math.ceil(bytes(text) / 4)
}

function norm(value: string) {
  return value.trim().toLowerCase()
}

function uniq(values: string[]) {
  return Array.from(new Set(values.map(norm).filter((value) => value.length > 0))).sort(
    (a, b) => a.localeCompare(b),
  )
}

function countExact(ruleValues: string[] | undefined, ctxValues: string[]) {
  if (!ruleValues || ruleValues.length === 0) return 0
  const ctx = new Set(ctxValues)
  return uniq(ruleValues).filter((value) => ctx.has(value)).length
}

function countKeywords(ruleValues: string[] | undefined, ctxValues: string[]) {
  if (!ruleValues || ruleValues.length === 0) return 0
  if (ctxValues.length === 0) return 0
  const text = ctxValues.join("\n")
  return uniq(ruleValues).filter((value) => text.includes(value)).length
}

function scoreRule(matchCounts: MatchCounts, rule: GuardrailRule) {
  const raw =
    matchCounts.signatures * 8 +
    matchCounts.paths * 4 +
    matchCounts.tools * 3 +
    matchCounts.keywords * 2
  const score =
    rule.userFeedbackRating === "negative" ? raw - NEGATIVE_RATING_PENALTY : raw
  return score
}

function tokenEstimateForRule(rule: GuardrailRule) {
  const signatures = [...(rule.match.signatures ?? [])].sort((a, b) => a.localeCompare(b))
  const paths = [...(rule.match.paths ?? [])].sort((a, b) => a.localeCompare(b))
  const tools = [...(rule.match.tools ?? [])].sort((a, b) => a.localeCompare(b))
  const keywords = [...(rule.match.keywords ?? [])].sort((a, b) => a.localeCompare(b))
  const text = [
    `id=${rule.id}`,
    `severity=${rule.rule.severity}`,
    `text=${rule.rule.text}`,
    `signatures=${signatures.join("|")}`,
    `paths=${paths.join("|")}`,
    `tools=${tools.join("|")}`,
    `keywords=${keywords.join("|")}`,
  ].join("\n")
  return estimateTokens(text)
}

function parseGitStatusPath(line: string) {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  const statusStripped = trimmed.replace(/^[A-Z?]{1,2}\s+/, "")
  if (statusStripped.length === 0) return undefined
  const renamed = statusStripped.split("->")
  return (renamed[renamed.length - 1] ?? "").trim()
}

function keywordTokens(values: string[]) {
  return values
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9._/-]+/g))
    .filter((value) => value.length >= 3)
}

export function contextFromSnapshot(snapshot: LastRunSnapshot): GuardrailContext {
  const signatures = snapshot.errorSignature ? [snapshot.errorSignature] : []
  const paths = uniq([
    ...snapshot.diff.files.map((item) => item.file),
    ...(snapshot.gitStatus?.lines
      .map((line) => parseGitStatusPath(line))
      .filter((value): value is string => Boolean(value)) ?? []),
  ])
  const tools = uniq(snapshot.tools.map((item) => item.tool))
  const keywords = uniq(
    keywordTokens([
      ...snapshot.errors.map((item) => item.snippet),
      ...snapshot.contextGaps,
    ]),
  )
  return {
    signatures,
    paths,
    tools,
    keywords,
  }
}

export function selectGuardrails(input: SelectGuardrailsInput): SelectGuardrailsResult {
  const cap = input.tokenCap ?? DEFAULT_GUARDRAIL_TOKEN_CAP
  const skip = new Set(input.skipIds ?? [])
  const context = {
    signatures: uniq(input.context.signatures ?? []),
    paths: uniq(input.context.paths ?? []),
    tools: uniq(input.context.tools ?? []),
    keywords: uniq(input.context.keywords ?? []),
  }

  const candidates = input.rules.map((rule) => {
    const matchCounts = {
      signatures: countExact(rule.match.signatures, context.signatures),
      paths: countExact(rule.match.paths, context.paths),
      tools: countExact(rule.match.tools, context.tools),
      keywords: countKeywords(rule.match.keywords, context.keywords),
      total: 0,
    }
    matchCounts.total =
      matchCounts.signatures +
      matchCounts.paths +
      matchCounts.tools +
      matchCounts.keywords
    const score = scoreRule(matchCounts, rule)
    const tokenEstimate = tokenEstimateForRule(rule)
    return {
      rule,
      trace: {
        id: rule.id,
        score,
        matchCounts,
        tokenEstimate,
        selected: false,
      } satisfies SelectionTraceItem,
    }
  })

  const ranked = [...candidates].sort((a, b) => {
    if (a.trace.score !== b.trace.score) return b.trace.score - a.trace.score
    return a.trace.id.localeCompare(b.trace.id)
  })

  let used = 0
  const selected: GuardrailRule[] = []
  const trace: SelectionTraceItem[] = []

  for (const candidate of ranked) {
    if (!candidate.rule.enabled) {
      trace.push({
        ...candidate.trace,
        selected: false,
        dropReason: "disabled",
      })
      continue
    }
    if (skip.has(candidate.rule.id)) {
      trace.push({
        ...candidate.trace,
        selected: false,
        dropReason: "skip_list",
      })
      continue
    }
    if (candidate.trace.score <= 0) {
      trace.push({
        ...candidate.trace,
        selected: false,
        dropReason: "non_positive_score",
      })
      continue
    }
    if (used + candidate.trace.tokenEstimate > cap) {
      trace.push({
        ...candidate.trace,
        selected: false,
        dropReason: "token_cap",
      })
      continue
    }
    selected.push(candidate.rule)
    used += candidate.trace.tokenEstimate
    trace.push({
      ...candidate.trace,
      selected: true,
    })
  }

  return {
    selected,
    selectedIds: selected.map((item) => item.id),
    tokenCap: cap,
    tokenEstimate: used,
    trace,
  }
}
