import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { oldClient, oldServer, unrepresentable } from "./client.ts"
import { ApiRoutes, serve } from "./Http.ts"
import * as Legacy from "./legacy.ts"

const scenarios = {
  "old-client": Effect.flatMap(serve(ApiRoutes), oldClient),
  "old-server": Effect.flatMap(serve(Legacy.ApiRoutes), oldServer),
  "unrepresentable": Effect.flatMap(serve(ApiRoutes), unrepresentable)
}

Effect.gen(function*() {
  const selected = process.argv[2] ?? "all"
  if (selected !== "all" && !Object.hasOwn(scenarios, selected)) {
    return yield* Effect.die(`Unknown scenario: ${selected}. Choose old-client, old-server, unrepresentable, or all.`)
  }
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (selected === "all" || name === selected) {
      // Each scenario gets fresh servers and data, closed when it ends.
      yield* scenario.pipe(Effect.scoped, Effect.timeout("30 seconds"))
    }
  }
}).pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain)
