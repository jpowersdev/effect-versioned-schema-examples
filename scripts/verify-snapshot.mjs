import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

// Verifies the packages each given pin file records, `snapshot.json` by default.
for (const pinFile of process.argv.length > 2 ? process.argv.slice(2) : ["snapshot.json"]) {
  const pin = JSON.parse(await readFile(new URL(`../${pinFile}`, import.meta.url), "utf8"))
  const base = pin.release.replace("/releases/tag/", "/releases/download/")
  for (const pkg of pin.packages) {
    const response = await fetch(`${base}/${pkg.file}`, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`${pkg.name}: HTTP ${response.status}`)
    const digest = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex")
    if (digest !== pkg.sha256) throw new Error(`${pkg.name}: SHA-256 mismatch`)
    console.log(`${pin.version} ${pkg.name}: verified ${digest}`)
  }
}
