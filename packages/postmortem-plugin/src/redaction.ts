export const REDACTED_SENTINEL = "[REDACTED]"
export const DEFAULT_EVIDENCE_ITEM_BYTES = 24 * 1024
export const DEFAULT_SNAPSHOT_TOTAL_BYTES = 200 * 1024
export const DEFAULT_FAILURE_TOTAL_BYTES = 300 * 1024
export const DEFAULT_GUARDRAIL_TOKEN_CAP = 400

export type PatternCount = Record<string, number>

export type RedactionReport = {
  totalReplacements: number
  patterns: PatternCount
  droppedDueToCaps: boolean
}

type Pass = {
  name: string
  regex: RegExp
  replace: (...args: string[]) => string
}

export type RedactOptions = {
  sentinel?: string
  maxBytes?: number
}

export type CapReport = {
  droppedDueToCaps: boolean
  truncatedItems: number
  droppedItems: number
  bytesIn: number
  bytesOut: number
}

export type GuardrailCapReport = {
  droppedDueToCaps: boolean
  tokenEstimateIn: number
  tokenEstimateOut: number
}

const passes: Pass[] = [
  {
    name: "pem_private_key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => REDACTED_SENTINEL,
  },
  {
    name: "env_assignment",
    regex: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s\r\n]+)/g,
    replace: (_m, key) => `${key}=${REDACTED_SENTINEL}`,
  },
  {
    name: "json_secret_key",
    regex: /("(?:api[_-]?key|token|secret|password)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,\n}\]]+)/gi,
    replace: (_m, prefix) => `${prefix}"${REDACTED_SENTINEL}"`,
  },
  {
    name: "authorization_header",
    regex: /(Authorization\s*:\s*)(?:Bearer|Basic|Token)?\s*[^\s\r\n]+/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED_SENTINEL}`,
  },
  {
    name: "github_token_ghp",
    regex: /\bghp_[A-Za-z0-9]{20,}\b/g,
    replace: () => REDACTED_SENTINEL,
  },
  {
    name: "github_token_pat",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: () => REDACTED_SENTINEL,
  },
  {
    name: "aws_access_key_id",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => REDACTED_SENTINEL,
  },
  {
    name: "high_entropy_fallback",
    regex: /\b(?=[A-Za-z0-9+/_-]{32,}\b)(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}\b/g,
    replace: () => REDACTED_SENTINEL,
  },
]

function bytes(text: string) {
  return Buffer.byteLength(text, "utf8")
}

function trimToBytes(text: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  if (bytes(text) <= maxBytes) return text
  let out = ""
  let used = 0
  for (const ch of text) {
    const next = Buffer.byteLength(ch, "utf8")
    if (used + next > maxBytes) return out
    out += ch
    used += next
  }
  return out
}

function replacePass(input: string, pass: Pass, sentinel: string) {
  let count = 0
  const out = input.replace(pass.regex, (...args) => {
    count += 1
    return pass.replace(...args).replaceAll(REDACTED_SENTINEL, sentinel)
  })
  return { out, count }
}

export function redact(text: string, options: RedactOptions = {}) {
  const sentinel = options.sentinel ?? REDACTED_SENTINEL
  const patterns: PatternCount = {}
  let out = text
  let total = 0
  for (const pass of passes) {
    const result = replacePass(out, pass, sentinel)
    out = result.out
    if (result.count > 0) patterns[pass.name] = result.count
    total += result.count
  }
  const maxBytes = options.maxBytes
  if (maxBytes === undefined) {
    return {
      text: out,
      report: {
        totalReplacements: total,
        patterns,
        droppedDueToCaps: false,
      } satisfies RedactionReport,
    }
  }
  const capped = trimToBytes(out, maxBytes)
  return {
    text: capped,
    report: {
      totalReplacements: total,
      patterns,
      droppedDueToCaps: bytes(capped) < bytes(out),
    } satisfies RedactionReport,
  }
}

function capTotal(items: string[], totalBytes: number) {
  const capped: string[] = []
  let used = 0
  let dropped = 0
  let truncated = 0
  for (const item of items) {
    const size = bytes(item)
    if (used + size <= totalBytes) {
      capped.push(item)
      used += size
      continue
    }
    const room = totalBytes - used
    if (room > 0) {
      capped.push(trimToBytes(item, room))
      used = totalBytes
      truncated += 1
    } else {
      dropped += 1
    }
  }
  return { capped, used, dropped, truncated }
}

export function enforceCaps(
  items: string[],
  options: {
    perItemBytes?: number
    totalBytes?: number
  } = {},
) {
  const perItemBytes = options.perItemBytes
  const totalBytes = options.totalBytes
  let truncatedItems = 0
  const perItem = perItemBytes
    ? items.map((item) => {
        const out = trimToBytes(item, perItemBytes)
        if (out !== item) truncatedItems += 1
        return out
      })
    : items
  const total = totalBytes
    ? capTotal(perItem, totalBytes)
    : {
        capped: perItem,
        used: perItem.reduce((sum, item) => sum + bytes(item), 0),
        dropped: 0,
        truncated: 0,
      }
  const bytesIn = items.reduce((sum, item) => sum + bytes(item), 0)
  const bytesOut = total.capped.reduce((sum, item) => sum + bytes(item), 0)
  return {
    items: total.capped,
    report: {
      droppedDueToCaps: bytesOut < bytesIn,
      truncatedItems: truncatedItems + total.truncated,
      droppedItems: total.dropped,
      bytesIn,
      bytesOut,
    } satisfies CapReport,
  }
}

export function enforceEvidenceCaps(items: string[], perItemBytes = DEFAULT_EVIDENCE_ITEM_BYTES) {
  return enforceCaps(items, {
    perItemBytes,
  })
}

export function enforceSnapshotCaps(items: string[], totalBytes = DEFAULT_SNAPSHOT_TOTAL_BYTES) {
  return enforceCaps(items, {
    totalBytes,
  })
}

export function enforceFailureCaps(items: string[], totalBytes = DEFAULT_FAILURE_TOTAL_BYTES) {
  return enforceCaps(items, {
    totalBytes,
  })
}

function estimateTokens(text: string) {
  return Math.ceil(bytes(text) / 4)
}

export function enforceGuardrailTokenCap(text: string, tokenCap = DEFAULT_GUARDRAIL_TOKEN_CAP) {
  const inTokens = estimateTokens(text)
  if (inTokens <= tokenCap) {
    return {
      text,
      report: {
        droppedDueToCaps: false,
        tokenEstimateIn: inTokens,
        tokenEstimateOut: inTokens,
      } satisfies GuardrailCapReport,
    }
  }
  const capped = trimToBytes(text, tokenCap * 4)
  return {
    text: capped,
    report: {
      droppedDueToCaps: true,
      tokenEstimateIn: inTokens,
      tokenEstimateOut: estimateTokens(capped),
    } satisfies GuardrailCapReport,
  }
}
