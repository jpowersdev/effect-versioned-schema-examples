import { execFile } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
for (const name of ["storage", "rpc", "cluster"]) {
  test(`${name} walkthrough completes its compatibility assertions`, async () => {
    await run(process.execPath, [fileURLToPath(new URL(`../examples/${name}.ts`, import.meta.url))], {
      timeout: 45_000,
      maxBuffer: 1_048_576
    })
  })
}
