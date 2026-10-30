import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { VersionedSchema } from "effect/schema"
import type { Person } from "./Domain/Person.ts"
import { Api as LegacyApi, type Person as LegacyPerson } from "./legacy.ts"
import { Api } from "./People/Api.ts"

// Observe the generated client's actual HTTP exchanges. This does not change
// requests or add retries; the version headers and bodies come from HttpApi.
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

// 1. An old mobile client keeps working after the API has been upgraded.
export const oldClient = Effect.fn(function*(baseUrl: string) {
  yield* Effect.logInfo("1. Old client → new server")
  const client = yield* HttpApiClient.make(LegacyApi, { baseUrl, transformClient: trace })
  const sent: LegacyPerson = { name: "Ada Lovelace", status: "active" }
  yield* Effect.logInfo("Old client sends", sent)
  const received = yield* client.people.save({ params: { id: "ada" }, payload: sent })
  yield* Effect.logInfo("Old client receives", received)
  yield* Effect.logInfo("The server used fullName; the old client still uses name.")
  return { sent, received }
})

// 2. A newly deployed client reaches an API instance that has not upgraded yet.
export const oldServer = Effect.fn(function*(baseUrl: string) {
  yield* Effect.logInfo("2. New client → old server")
  const client = yield* HttpApiClient.make(Api, { baseUrl, transformClient: trace })
  const read = yield* client.people.getById({ params: { id: "ada" } })
  yield* Effect.logInfo("New client upgrades the old response locally", read)

  const sent: Person = { ...read, email: "ada@example.com" }
  yield* Effect.logInfo("New client attempts to write", sent)
  const save = client.people.save({ params: { id: "ada" }, payload: sent })
  let unsupported: VersionedSchema.VersionUnsupported | undefined
  const received = yield* save.pipe(Effect.catchTag(
    "VersionUnsupported",
    Effect.fn(function*(error) {
      unsupported = error
      yield* Effect.logInfo("Rejected before the handler: VersionUnsupported", error.supported)
      yield* Effect.logInfo("Application chooses one retry at the server's versions; email will be dropped.")
      return yield* save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))
    })
  ))
  if (unsupported === undefined) return yield* Effect.die("Expected the old server to reject the newer write")
  yield* Effect.logInfo("New client receives the compatible reply", received)
  return { read, sent, unsupported, received }
})

// 3. Some changes cannot be translated without inventing a different meaning.
export const unrepresentable = Effect.fn(function*(baseUrl: string) {
  yield* Effect.logInfo("3. An archived person → an old client")
  const client = yield* HttpApiClient.make(LegacyApi, { baseUrl, transformClient: trace })
  const failure = yield* Effect.flip(client.people.getById({ params: { id: "grace" } }))
  if (!(failure instanceof VersionedSchema.Unrepresentable)) return yield* Effect.fail(failure)
  yield* Effect.logInfo("Old client receives a typed Unrepresentable failure", { reason: failure.reason })
  yield* Effect.logInfo("No fallback status is invented, and the request is not retried.")
  return failure
})
