import { assert, describe, it } from "@effect/vitest"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

// Runs an example as `pnpm example:<name>` would and returns its output. The
// examples exit with an error if anything fails unexpectedly.
const run = async (name: string) => {
  const file = fileURLToPath(new URL(`../examples/${name}.ts`, import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [file], { timeout: 45_000 })
  return stdout
}

// Asserts that each text appears in the output after the one before it.
const assertInOrder = (output: string, ...expected: Array<string>) => {
  let from = 0
  for (const text of expected) {
    const at = output.indexOf(text, from)
    assert.isAtLeast(at, 0, `Expected "${text}" next in the output`)
    from = at + text.length
  }
}

describe("supporting examples", () => {
  it("storage", async () => {
    const output = await run("storage")
    assertInOrder(output, "Read a stored v1 record", "Write for older readers", "Write a contact for older readers")
  })

  it("rpc", async () => {
    const output = await run("rpc")
    assertInOrder(
      output,
      "New RPC handler receives",
      "Old server rejects the write before its handler runs",
      "Old RPC handler receives",
      "New client receives",
      "Old client receives a stream item",
      "Stream ends at a person v1 can't hold"
    )
  })

  it("onboarding", async () => {
    const output = await run("onboarding")
    assertInOrder(
      output,
      "Installed client can't read the latest version",
      "Installed client reads, with the pin",
      "Server handler receives",
      "Installed client saves, with the pin",
      "Current client reads"
    )
  })

  it("cluster", async () => {
    const output = await run("cluster")
    assertInOrder(
      output,
      "Old runner handles",
      "Waiting in SQLite",
      // Once for each save waiting for Ada
      "Upgraded runner handles",
      "Upgraded runner handles",
      "Upgraded caller receives",
      "Old caller receives"
    )
  })
})
