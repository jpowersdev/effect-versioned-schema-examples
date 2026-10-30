import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { VersionedSchema } from "effect/schema"
import type { Person } from "./Domain/Person.ts"
import { Api as LegacyApi, type Person as LegacyPerson } from "./legacy.ts"
import { Api } from "./People/Api.ts"

// Logs the generated client's HTTP exchanges without changing them. The version
// headers and bodies come from HttpApi.
const trace = (client: HttpClient.HttpClient) =>
  client.pipe(
    HttpClient.tapRequest((request) =>
      Effect.logInfo("HTTP request", {
        method: request.method,
        versions: request.headers[VersionedSchema.header],
        body: request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined
      })
    ),
    HttpClient.tap(Effect.fn(function*(response) {
      yield* Effect.logInfo("HTTP response", { status: response.status, body: yield* response.json })
    }))
  )

// 1. An installed mobile client keeps working after the API has been upgraded.
export const oldClient = Effect.fn("oldClient")(function*(baseUrl: string) {
  yield* Effect.logInfo("1. Old client → new server")
  const client = yield* HttpApiClient.make(LegacyApi, { baseUrl, transformClient: trace })
  const person: LegacyPerson = { name: "Ada Lovelace", status: "active" }
  yield* Effect.logInfo("Old client sends", person)
  const saved = yield* client.people.save({ params: { id: "ada" }, payload: person })
  yield* Effect.logInfo("Old client receives", saved)
})

// 2. A newly deployed client reaches an API instance that has not upgraded yet.
export const oldServer = Effect.fn("oldServer")(function*(baseUrl: string) {
  yield* Effect.logInfo("2. New client → old server")
  const client = yield* HttpApiClient.make(Api, { baseUrl, transformClient: trace })
  const person = yield* client.people.getById({ params: { id: "ada" } })
  yield* Effect.logInfo("New client reads", person)

  const updated: Person = { ...person, email: "ada@example.com" }
  yield* Effect.logInfo("New client writes", updated)
  const save = client.people.save({ params: { id: "ada" }, payload: updated })
  // This application accepts losing email on an old server, so it retries once
  // at the versions that server supports. The rejection came before its handler ran.
  const saved = yield* save.pipe(
    Effect.catchTag("VersionUnsupported", (error) =>
      Effect.logInfo("Old server rejects the write before its handler runs", error.supported).pipe(
        Effect.andThen(save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported)))
      ))
  )
  yield* Effect.logInfo("New client receives", saved)
})

// 3. A value the old client's version can't hold fails instead of being changed.
export const unrepresentable = Effect.fn("unrepresentable")(function*(baseUrl: string) {
  yield* Effect.logInfo("3. An archived person → an old client")
  const client = yield* HttpApiClient.make(LegacyApi, { baseUrl, transformClient: trace })
  yield* client.people.getById({ params: { id: "grace" } }).pipe(
    Effect.flatMap((person) => Effect.logInfo("Old client receives", person)),
    Effect.catchTag("Unrepresentable", (error) =>
      Effect.logWarning("Old client can't show this person", { reason: error.reason }))
  )
})
