import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "./Api.ts"

Effect.gen(function*() {
  const baseUrl = yield* Config.String("API_URL").pipe(Config.withDefault("http://127.0.0.1:3000"))
  const client = yield* HttpApiClient.make(Api, { baseUrl })
  const person = yield* client.people.getById({ params: { id: "ada" } })
  yield* Effect.logInfo("Loaded person", person)

  const saved = yield* client.people.save({
    params: { id: "ada" },
    payload: { ...person, email: "ada.lovelace@example.com" }
  })
  yield* Effect.logInfo("Saved person", saved)
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  NodeRuntime.runMain
)
