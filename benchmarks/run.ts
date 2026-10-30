// Compares the proposal build with the baseline it's based on:
//
//   pnpm bench [--rounds 10]
//
// Every case runs in a fresh process. Within a round, the baseline and the
// proposal take turns going first, and each difference is taken between the two
// runs of the same round. The results are printed as Markdown tables and saved
// to benchmarks/results.json.
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { cpus, platform, release } from "node:os"

interface Case {
  readonly transport: "httpapi" | "rpc"
  readonly call: "get" | "save" | "build"
  readonly schema: "plain" | "versioned"
  readonly version: "latest" | "v1"
}

interface Result extends Case {
  readonly build: "base" | "proposal"
  readonly round: number
  readonly nsPerCall: number
}

const roundsFlag = process.argv.indexOf("--rounds")
const rounds = roundsFlag === -1 ? 10 : Number(process.argv[roundsFlag + 1])
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer")

const transports = ["httpapi", "rpc"] as const
const calls = ["get", "save", "build"] as const

// Cases without a versioned schema run on both builds.
const plainCases: Array<Case> = transports.flatMap((transport) =>
  calls.map((call) => ({
    transport,
    call,
    schema: "plain",
    version: "latest"
  }))
)

// Cases with a versioned schema only run on the proposal.
const versionedCases: Array<Case> = transports.flatMap((transport) =>
  calls.flatMap((call) =>
    (call === "build" ? ["latest"] as const : ["latest", "v1"] as const).map((version) => ({
      transport,
      call,
      schema: "versioned",
      version
    }))
  )
)

const run = (build: Result["build"], round: number, benchmark: Case): Result => {
  const args = [
    ...(build === "base" ? ["--import", "./benchmarks/base.mjs"] : []),
    `benchmarks/${benchmark.transport}.ts`,
    benchmark.call,
    benchmark.schema,
    benchmark.version
  ]
  const output = execFileSync(process.execPath, args, {
    encoding: "utf8"
  })
  const { nsPerCall } = JSON.parse(output.trim().split("\n").at(-1)!)
  return {
    ...benchmark,
    build,
    round,
    nsPerCall
  }
}

const results: Array<Result> = []
for (let round = 1; round <= rounds; round++) {
  for (const benchmark of plainCases) {
    const order = round % 2 === 1 ? ["base", "proposal"] as const : ["proposal", "base"] as const
    for (const build of order) results.push(run(build, round, benchmark))
  }
  for (const benchmark of versionedCases) results.push(run("proposal", round, benchmark))
  console.error(`round ${round} of ${rounds} done`)
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

// A 95% interval for the median of `values`, by resampling with a fixed seed.
const bootstrap = (values: ReadonlyArray<number>) => {
  let seed = 1
  const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647
  const medians = Array.from({
    length: 5_000
  }, () => median(values.map(() => values[Math.floor(random() * values.length)]!)))
    .sort((a, b) => a - b)
  return [medians[125]!, medians[4_874]!] as const
}

const same = (a: Case, b: Case) =>
  a.transport === b.transport && a.call === b.call && a.schema === b.schema && a.version === b.version

const timesOf = (benchmark: Case, build: Result["build"]) =>
  results.filter((result) => same(result, benchmark) && result.build === build)

const label = (benchmark: Case) =>
  `${benchmark.transport === "httpapi" ? "HttpApi" : "Rpc"} ${benchmark.call}${
    benchmark.version === "v1" ? ", client at v1" : ""
  }`

const micros = (ns: number) => `${(ns / 1_000).toFixed(1)} µs`
const percent = (ratio: number) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`

console.log(`Measured on ${cpus()[0]?.model} (${cpus().length} threads), Node ${process.version}, ${rounds} rounds.\n`)
console.log("Without a versioned schema, proposal vs baseline:\n")
console.log("| Call | Baseline | Proposal | Difference (95% interval) |")
console.log("| --- | --- | --- | --- |")
for (const benchmark of plainCases) {
  const base = timesOf(benchmark, "base")
  const proposal = timesOf(benchmark, "proposal")
  const ratios = base.map((b) => Math.log(proposal.find((p) => p.round === b.round)!.nsPerCall / b.nsPerCall))
  const [low, high] = bootstrap(ratios)
  console.log(
    `| ${label(benchmark)} | ${micros(median(base.map((r) => r.nsPerCall)))} | ${
      micros(median(proposal.map((r) => r.nsPerCall)))
    } | ${percent(Math.exp(median(ratios)))} (${percent(Math.exp(low))} to ${percent(Math.exp(high))}) |`
  )
}

console.log("\nWith a versioned schema on the proposal, vs a plain schema on the baseline:\n")
console.log("| Call | Baseline, plain schema | Proposal, versioned schema | Difference |")
console.log("| --- | --- | --- | --- |")
for (const benchmark of versionedCases) {
  const base = median(timesOf({ ...benchmark, schema: "plain", version: "latest" }, "base").map((r) => r.nsPerCall))
  const proposal = median(timesOf(benchmark, "proposal").map((r) => r.nsPerCall))
  console.log(
    `| ${label(benchmark)} | ${micros(base)} | ${micros(proposal)} | +${micros(proposal - base)} (${
      percent(proposal / base)
    }) |`
  )
}

writeFileSync(
  new URL("results.json", import.meta.url),
  `${
    JSON.stringify(
      {
        date: new Date().toISOString(),
        node: process.version,
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        rounds,
        results
      },
      null,
      2
    )
  }\n`
)
