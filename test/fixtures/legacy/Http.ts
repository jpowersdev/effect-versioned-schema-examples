import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "./Api.ts"
import { PersonNotFound } from "./Domain/Person.ts"
import { ada } from "./Seed.ts"

export const makeLegacyHttp = () => {
  const calls = { saves: 0 }
  const routes = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(HttpApiBuilder.group(Api, "people", (handlers) =>
      handlers
        .handle("getById", ({ params }) =>
          params.id === "ada"
            ? Effect.succeed(ada)
            : Effect.fail(new PersonNotFound({ id: params.id })))
        .handle(
          "save",
          Effect.fn(function*({ payload, versions }) {
            calls.saves++
            yield* Effect.logInfo("Legacy HTTP handler").pipe(Effect.annotateLogs({ versions }))
            return payload
          })
        )))
  )
  return { routes, calls }
}
