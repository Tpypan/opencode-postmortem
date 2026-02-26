import { describe, expect, test } from "bun:test"
import { postmortemPlugin } from "../src/index"

describe("postmortem plugin", () => {
  test("initializes idle event hook", async () => {
    const input = {
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
      directory: "/tmp/postmortem-plugin",
      worktree: "/tmp/postmortem-plugin",
      serverUrl: new URL("http://localhost:4096"),
      $: Bun.$,
    } as Parameters<typeof postmortemPlugin>[0]

    const hooks = await postmortemPlugin(input)

    expect(typeof hooks.event).toBe("function")
  })
})
