import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

type ParseResult = {
  target: string
}

type CopyResult = {
  copied: number
  skipped: number
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv: string[]): ParseResult {
  let target = process.cwd()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--target") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("missing value for --target")
      }
      target = value
      index += 1
      continue
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  return { target: path.resolve(target) }
}

async function resolveTemplatesDir(): Promise<string> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(scriptDir, "../../src/templates"),
    path.resolve(scriptDir, "../src/templates"),
  ]

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  throw new Error(`unable to locate templates directory from ${scriptDir}`)
}

async function copyIfMissing(sourcePath: string, destinationPath: string, relativePath: string): Promise<CopyResult> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true })

  if (await pathExists(destinationPath)) {
    console.log(`  [skip] ${relativePath} (already exists)`)
    return { copied: 0, skipped: 1 }
  }

  await fs.copyFile(sourcePath, destinationPath)
  console.log(`  [copy] ${relativePath}`)
  return { copied: 1, skipped: 0 }
}

async function copyCommandTemplates(templatesDir: string, targetRoot: string): Promise<CopyResult> {
  const commandsTemplateDir = path.join(templatesDir, "commands")
  const commandEntries = await fs.readdir(commandsTemplateDir, { withFileTypes: true })

  let copied = 0
  let skipped = 0

  const commandFiles = commandEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  for (const commandFile of commandFiles) {
    const sourcePath = path.join(commandsTemplateDir, commandFile)
    const relativePath = path.posix.join(".opencode", "commands", commandFile)
    const destinationPath = path.join(targetRoot, ".opencode", "commands", commandFile)
    const result = await copyIfMissing(sourcePath, destinationPath, relativePath)
    copied += result.copied
    skipped += result.skipped
  }

  return { copied, skipped }
}

async function copySkillTemplates(templatesDir: string, targetRoot: string): Promise<CopyResult> {
  const skillsTemplateDir = path.join(templatesDir, "skills")
  const skillEntries = await fs.readdir(skillsTemplateDir, { withFileTypes: true })

  let copied = 0
  let skipped = 0

  const skillDirectories = skillEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  for (const skillName of skillDirectories) {
    const sourcePath = path.join(skillsTemplateDir, skillName, "SKILL.md")
    if (!(await pathExists(sourcePath))) {
      throw new Error(`missing skill template: ${sourcePath}`)
    }

    const relativePath = path.posix.join(".opencode", "skills", skillName, "SKILL.md")
    const destinationPath = path.join(targetRoot, ".opencode", "skills", skillName, "SKILL.md")
    const result = await copyIfMissing(sourcePath, destinationPath, relativePath)
    copied += result.copied
    skipped += result.skipped
  }

  return { copied, skipped }
}

async function ensurePostmortemConfig(targetRoot: string): Promise<CopyResult> {
  const relativePath = path.posix.join(".opencode", "postmortem.json")
  const destinationPath = path.join(targetRoot, relativePath)

  await fs.mkdir(path.dirname(destinationPath), { recursive: true })

  if (await pathExists(destinationPath)) {
    console.log(`  [skip] ${relativePath} (already exists)`)
    return { copied: 0, skipped: 1 }
  }

  await fs.writeFile(destinationPath, "{}", "utf8")
  console.log(`  [copy] ${relativePath}`)
  return { copied: 1, skipped: 0 }
}

async function main() {
  const { target } = parseArgs(process.argv.slice(2))
  const templatesDir = await resolveTemplatesDir()

  console.log(`Initializing templates in ${target}`)

  const commandResult = await copyCommandTemplates(templatesDir, target)
  const skillResult = await copySkillTemplates(templatesDir, target)
  const configResult = await ensurePostmortemConfig(target)

  const copied = commandResult.copied + skillResult.copied + configResult.copied
  const skipped = commandResult.skipped + skillResult.skipped + configResult.skipped

  console.log("")
  console.log(`Done. Copied ${copied} file(s), skipped ${skipped} file(s).`)
  console.log("Next step: Add 'agentpostmortem' to your opencode.json plugin array.")
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`init failed: ${message}`)
  process.exitCode = 1
})
