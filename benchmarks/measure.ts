import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

export interface Args {
  readonly call: "get" | "save" | "build"
  readonly schema: "plain" | "versioned"
  readonly version: "latest" | "v1"
}

// Reads `<get | save | build> <plain | versioned> <latest | v1>`.
export const parseArgs = (): Args => {
  const [call, schema, version = "latest"] = process.argv.slice(2)
  if (call !== "get" && call !== "save" && call !== "build") throw new Error(`Unknown call: ${call}`)
  if (schema !== "plain" && schema !== "versioned") throw new Error(`Unknown schema: ${schema}`)
  if (version !== "latest" && version !== "v1") throw new Error(`Unknown version: ${version}`)
  return {
    call,
    schema,
    version
  }
}

// An HttpClient whose requests go straight to a web handler, so the benchmark
// measures encoding, negotiation and decoding without a network.
export const layerInProcessClient = (handler: (request: Request) => Promise<Response>) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, ((input, init) => handler(new Request(input, init))) as typeof fetch)
    )
  )

// Fails unless `call` produces `expected`, so a broken case can't report a time.
export const check = <A, E, R>(call: Effect.Effect<A, E, R>, expected: unknown) =>
  Effect.flatMap(call, (actual) =>
    JSON.stringify(actual) === JSON.stringify(expected)
      ? Effect.void
      : Effect.die(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`))

// Runs `call` `iterations` times per sample after a warmup, and returns the
// median time per call in nanoseconds, with the fastest and slowest samples.
export const measure = <A, E, R>(call: Effect.Effect<A, E, R>, options: {
  readonly warmup: number
  readonly iterations: number
  readonly samples: number
}) =>
  Effect.gen(function*() {
    for (let i = 0; i < options.warmup; i++) yield* call

    const samples: Array<number> = []
    for (let sample = 0; sample < options.samples; sample++) {
      const start = performance.now()
      for (let i = 0; i < options.iterations; i++) yield* call
      samples.push((performance.now() - start) * 1_000_000 / options.iterations)
    }

    const sorted = [...samples].sort((a, b) => a - b)
    return {
      nsPerCall: sorted[Math.floor(sorted.length / 2)]!,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!
    }
  })

// Calls keep getting faster for about 15,000 calls while V8 optimizes them,
// so samples start after that.
export const iterationsFor = (call: Args["call"]) =>
  call === "build"
    ? {
      warmup: 200,
      iterations: 50,
      samples: 10
    }
    : {
      warmup: 15_000,
      iterations: 2_000,
      samples: 10
    }
