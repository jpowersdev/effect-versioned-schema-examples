import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Builds the packages a pin file records, `snapshot.json` by default.
const root = fileURLToPath(new URL("../", import.meta.url))
const pin = JSON.parse(await readFile(join(root, process.argv[2] ?? "snapshot.json"), "utf8"))
const checkout = await mkdtemp(join(tmpdir(), "effect-versioned-build-"))
const artifacts = join(root, ".artifacts", pin.version)
await mkdir(artifacts, { recursive: true })
const run = (command, args, cwd = checkout) => execFileSync(command, args, { cwd, stdio: "inherit" })

try {
  run("git", ["init", "--quiet"])
  run("git", ["remote", "add", "origin", pin.repository])
  run("git", ["fetch", "--depth=1", "origin", pin.commit])
  run("git", ["checkout", "--detach", "FETCH_HEAD"])
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim()
  if (revision !== pin.commit) throw new Error(`Unexpected source revision: ${revision}`)

  run("pnpm", ["install", "--frozen-lockfile"])
  run("node", ["scripts/set-strip-internal.mjs"])
  run("pnpm", ["codemod"])
  run("pnpm", ["build"])

  // Set every participating version before pnpm resolves workspace ranges.
  for (const pkg of pin.packages) {
    const file = join(checkout, pkg.path, "package.json")
    const manifest = JSON.parse(await readFile(file, "utf8"))
    manifest.version = pin.version
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  const sums = []
  for (const pkg of pin.packages) {
    run(
      "pnpm",
      ["--config.verifyDepsBeforeRun=false", "pack", "--pack-destination", artifacts],
      join(checkout, pkg.path)
    )
    const digest = createHash("sha256").update(await readFile(join(artifacts, pkg.file))).digest("hex")
    sums.push(`${digest}  ${pkg.file}`)
  }
  await writeFile(join(artifacts, "SHA256SUMS"), `${sums.join("\n")}\n`)
  console.log(`Built ${pin.commit}. Packages and checksums: ${artifacts}`)
} finally {
  await rm(checkout, { recursive: true, force: true })
}
