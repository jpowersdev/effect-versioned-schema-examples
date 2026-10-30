import { NodeRuntime } from "@effect/platform-node"
import { Effect, type Scope } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { oldClient, oldServer, unrepresentable } from "./client.ts"
import { LegacyRoutes, Routes, serve } from "./People/Http.ts"

const scenarios: Record<string, Effect.Effect<void, unknown, HttpClient.HttpClient | Scope.Scope>> = {
  "old-client": Effect.gen(function*() {
    return yield* oldClient(yield* serve(Routes))
  }).pipe(Effect.asVoid),
  "old-server": Effect.gen(function*() {
    return yield* oldServer(yield* serve(LegacyRoutes))
  }).pipe(Effect.asVoid),
  "unrepresentable": Effect.gen(function*() {
    return yield* unrepresentable(yield* serve(Routes))
  }).pipe(Effect.asVoid)
}

Effect.gen(function*() {
  const selected = process.argv[2] ?? "all"
  if (selected !== "all" && !Object.hasOwn(scenarios, selected)) {
    return yield* Effect.die(`Unknown scenario: ${selected}. Choose old-client, old-server, unrepresentable, or all.`)
  }
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (selected === "all" || name === selected) {
      yield* scenario.pipe(Effect.scoped, Effect.timeout("30 seconds"))
    }
  }
}).pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain)
