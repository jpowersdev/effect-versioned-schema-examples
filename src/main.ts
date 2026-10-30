import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { oldClient, oldServer, unrepresentable } from "./client.ts"
import { HttpServerLayer } from "./Http.ts"
import * as Previous from "./previous.ts"

// Each scenario gets its own server and fresh data, closed when it ends.
const scenarios = {
  "old-client": oldClient.pipe(Effect.provide(HttpServerLayer)),
  "old-server": oldServer.pipe(Effect.provide(Previous.HttpServerLayer)),
  "unrepresentable": unrepresentable.pipe(Effect.provide(HttpServerLayer))
}

Effect.gen(function*() {
  const selected = process.argv[2] ?? "all"
  if (selected !== "all" && !Object.hasOwn(scenarios, selected)) {
    return yield* Effect.die(
      `Unknown scenario: ${selected}. Choose old-client, old-server, unrepresentable, or all.`
    )
  }

  for (const [name, scenario] of Object.entries(scenarios)) {
    if (selected === "all" || name === selected) {
      yield* scenario.pipe(Effect.timeout("30 seconds"))
    }
  }
}).pipe(
  NodeRuntime.runMain
)
