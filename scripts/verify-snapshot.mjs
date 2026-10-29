import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

const pin = JSON.parse(await readFile(new URL("../snapshot.json", import.meta.url), "utf8"))
const base = pin.release.replace("/releases/tag/", "/releases/download/")
for (const pkg of pin.packages) {
  const response = await fetch(`${base}/${pkg.file}`, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${pkg.name}: HTTP ${response.status}`)
  const digest = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex")
  if (digest !== pkg.sha256) throw new Error(`${pkg.name}: SHA-256 mismatch`)
  console.log(`${pkg.name}: verified ${digest}`)
}
