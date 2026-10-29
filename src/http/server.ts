import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"
import { ApiV1, ApiV3 } from "./api.ts"

export const makeServers = () => {
  const calls = { oldSaves: 0 }
  const old = HttpApiBuilder.layer(ApiV1).pipe(
    Layer.provide(HttpApiBuilder.group(ApiV1, "people", (handlers) =>
      handlers
        .handle("get", () => Effect.succeed(V1.ada))
        .handle("save", ({ payload, versions }) =>
          Effect.sync(() => {
            calls.oldSaves++
            console.log("v1 HTTP handler negotiated:", versions)
            return payload
          }))))
  )
  const current = HttpApiBuilder.layer(ApiV3).pipe(
    Layer.provide(HttpApiBuilder.group(ApiV3, "people", (handlers) =>
      handlers
        .handle("get", ({ params }) => Effect.succeed(params.id === "archived" ? V3.archived : V3.ada))
        .handle("save", ({ payload, versions }) =>
          Effect.sync(() => {
            console.log("v3 HTTP handler negotiated:", versions)
            return payload
          }))))
  )
  return { old, current, calls }
}
