import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { postmortemPlugin } from "../src/index"
import { resolvePostmortemRoot } from "../src/storage/paths"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("postmortem_config tool", () => {
  test("shows default user storage and can set repo storage", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-config-tool-"))
    dirs.push(worktree)

    const plugin = await postmortemPlugin({
      client: {
        session: {
          messages: async () => ({
            data: [],
            error: undefined,
            response: new Response(),
          }),
          diff: async () => ({
            data: [],
            error: undefined,
            response: new Response(),
          }),
        },
      },
      project: {} as Parameters<typeof postmortemPlugin>[0]["project"],
      directory: worktree,
      worktree,
      serverUrl: new URL("http://localhost:4096"),
      $: Bun.$,
    } as Parameters<typeof postmortemPlugin>[0])

    const configTool = plugin.tool.postmortem_config
    const ctx = {
      worktree,
      sessionID: "session-config",
    }

    const before = JSON.parse(await configTool.execute({ action: "show", json: true }, ctx))
    expect(before.ok).toBe(true)
    expect(before.storage).toBe("user")
    expect(before.storeRaw).toBe(false)

    const after = JSON.parse(
      await configTool.execute({ action: "set", storage: "repo", json: true }, ctx),
    )
    expect(after.ok).toBe(true)
    expect(after.storage).toBe("repo")
    expect(after.storeRaw).toBe(false)
    expect(after.root).toContain(path.join(worktree, ".opencode", "postmortems"))

    const config = await fs.readFile(path.join(worktree, ".opencode", "postmortem.json"), "utf8")
    expect(config).toContain('"storage": "repo"')
  })

  test("enabling storeRaw writes last-run.json and last-run.raw.json", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-config-raw-"))
    dirs.push(worktree)

    const plugin = await postmortemPlugin({
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                parts: [
                  {
                    type: "tool",
                    tool: "bash",
                    state: {
                      status: "error",
                      error: "ENOENT and API_KEY=top-secret",
                    },
                  },
                ],
              },
            ],
            error: undefined,
            response: new Response(),
          }),
          diff: async () => ({
            data: [],
            error: undefined,
            response: new Response(),
          }),
        },
      },
      project: {} as Parameters<typeof postmortemPlugin>[0]["project"],
      directory: worktree,
      worktree,
      serverUrl: new URL("http://localhost:4096"),
      $: Bun.$,
    } as Parameters<typeof postmortemPlugin>[0])

    const configTool = plugin.tool.postmortem_config
    const ctx = {
      worktree,
      sessionID: "session-config-raw",
    }
    await configTool.execute({ action: "set", storage: "repo", storeRaw: true }, ctx)

    if (!plugin.event) throw new Error("event hook missing")
    await plugin.event({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "session-raw",
        },
      },
    } as Parameters<NonNullable<typeof plugin.event>>[0])

    const root = (await resolvePostmortemRoot(worktree)).root
    const redacted = await fs.readFile(path.join(root, "last-run.json"), "utf8")
    const raw = await fs.readFile(path.join(root, "last-run.raw.json"), "utf8")

    expect(redacted).not.toContain("top-secret")
    expect(raw).toContain("top-secret")
  })

  test("refuses repo storage when .opencode/postmortems is a symlink and falls back to user root", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-config-symlink-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-config-escape-"))
    dirs.push(worktree, outside)

    await fs.mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await fs.symlink(outside, path.join(worktree, ".opencode", "postmortems"), "dir")

    const plugin = await postmortemPlugin({
      client: {
        session: {
          messages: async () => ({
            data: [],
            error: undefined,
            response: new Response(),
          }),
          diff: async () => ({
            data: [],
            error: undefined,
            response: new Response(),
          }),
        },
      },
      project: {} as Parameters<typeof postmortemPlugin>[0]["project"],
      directory: worktree,
      worktree,
      serverUrl: new URL("http://localhost:4096"),
      $: Bun.$,
    } as Parameters<typeof postmortemPlugin>[0])

    const configTool = plugin.tool.postmortem_config
    const ctx = {
      worktree,
      sessionID: "session-config-symlink",
    }

    const denied = JSON.parse(
      await configTool.execute({ action: "set", storage: "repo", json: true }, ctx),
    )
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain("symlink")

    const configPath = path.join(worktree, ".opencode", "postmortem.json")
    await expect(fs.readFile(configPath, "utf8")).rejects.toThrow()

    await fs.writeFile(configPath, '{"storage":"repo"}\n', "utf8")
    const resolved = await resolvePostmortemRoot(worktree)
    expect(resolved.root).toBe(resolved.defaultRoot)
  })
})
