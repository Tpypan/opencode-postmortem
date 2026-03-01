import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function run(command: string[], cwd: string): RunResult {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8" })

  if (result.error) {
    return {
      exitCode: 1,
      stdout: result.stdout ?? "",
      stderr: result.error.message,
    }
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

describe("install smoke", () => {
  test("packed init script copies templates and handles unknown args", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const packDir = await tempDir("postmortem-pack-")
    const extractDir = await tempDir("postmortem-extract-")
    const targetDir = await tempDir("postmortem-target-")

    const packWithDestination = run(["npm", "pack", "--pack-destination", packDir], repoRoot)
    if (packWithDestination.exitCode !== 0) {
      const packFallback = run(["npm", "pack", repoRoot], packDir)
      if (packFallback.exitCode !== 0) {
        throw new Error(
          `npm pack failed\n--pack-destination stderr:\n${packWithDestination.stderr}\nfallback stderr:\n${packFallback.stderr}`,
        )
      }
    }

    const tarballs = (await fs.readdir(packDir)).filter((entry) => entry.endsWith(".tgz"))
    expect(tarballs.length).toBe(1)

    const tarballPath = path.join(packDir, tarballs[0])
    const extractResult = run(["tar", "-xzf", tarballPath, "-C", extractDir], repoRoot)
    if (extractResult.exitCode !== 0) {
      throw new Error(`failed to extract tarball: ${extractResult.stderr}`)
    }

    const packageDir = path.join(extractDir, "package")
    const initScriptPath = path.join("dist", "scripts", "init.js")

    const firstInit = run(["node", initScriptPath, "--target", targetDir], packageDir)
    expect(firstInit.exitCode).toBe(0)

    expect(await exists(path.join(targetDir, ".opencode", "postmortem.json"))).toBe(true)
    expect(await exists(path.join(targetDir, ".opencode", "commands", "inspect.md"))).toBe(true)
    expect(await exists(path.join(targetDir, ".opencode", "skills", "inspect", "SKILL.md"))).toBe(true)

    const secondInit = run(["node", initScriptPath, "--target", targetDir], packageDir)
    expect(secondInit.exitCode).toBe(0)

    const unknownArgRun = run(["node", initScriptPath, "--unknown-flag"], packageDir)
    expect(unknownArgRun.exitCode).not.toBe(0)
    expect(unknownArgRun.stderr).toContain("unknown argument")
  })
})
