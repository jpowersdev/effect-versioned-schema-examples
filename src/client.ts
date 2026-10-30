import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { VersionedSchema } from "effect/schema"
import type { Person } from "./Domain/Person.ts"
import { Api } from "./People/Api.ts"
import * as Previous from "./previous.ts"

// Logs the generated client's HTTP exchanges without changing them. The version
// headers and bodies come from HttpApi. The comments below show these logs as
// `HTTP request, <versions header>` and `HTTP response, <status>`.
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
      const body = yield* response.json
      yield* Effect.logInfo("HTTP response", {
        status: response.status,
        body
      })
    }))
  )

// 1. An old mobile client keeps working after the API has been upgraded.
export const oldClient = Effect.gen(function*() {
  yield* Effect.logInfo("1. Old client → new server")
  const client = yield* HttpApiClient.make(Previous.Api, {
    transformClient: trace
  })

  const person: Previous.Person = {
    name: "Ada Lovelace",
    status: "active"
  }
  yield* Effect.logInfo("Old client sends", person)
  // => { name: "Ada Lovelace", status: "active" }

  // The new server upgrades the request before its handler runs, and writes the
  // response at the version the client sent.
  const saved = yield* client.people.save({
    params: {
      id: "ada"
    },
    payload: person
  })
  // => HTTP request, Person=1      { _version: 1, name: "Ada Lovelace", status: "active" }
  // => New server handler receives { fullName: "Ada Lovelace", status: "active" }
  // => HTTP response, 200          { _version: 1, name: "Ada Lovelace", status: "active" }

  yield* Effect.logInfo("Old client receives", saved)
  // => { name: "Ada Lovelace", status: "active" }
})

// 2. A newly deployed client reaches an API instance that has not upgraded yet.
export const oldServer = Effect.gen(function*() {
  yield* Effect.logInfo("2. New client → old server")
  const client = yield* HttpApiClient.make(Api, {
    transformClient: trace
  })

  // The old server answers at v1, and the new client upgrades the response.
  const person = yield* client.people.getById({
    params: {
      id: "ada"
    }
  })
  // => HTTP request, Person=3 (no body)
  // => Old server returns     { name: "Ada", status: "active" }
  // => HTTP response, 200     { _version: 1, name: "Ada", status: "active" }

  yield* Effect.logInfo("New client reads", person)
  // => { fullName: "Ada", status: "active" }

  const updated: Person = {
    ...person,
    email: "ada@example.com"
  }
  yield* Effect.logInfo("New client writes", updated)
  // => { fullName: "Ada", status: "active", email: "ada@example.com" }

  // The old server rejects a v3 write before its handler runs. This application
  // accepts losing email there, so it retries once at the versions the server
  // supports.
  const save = client.people.save({
    params: {
      id: "ada"
    },
    payload: updated
  })
  const saved = yield* save.pipe(
    Effect.catchTag("VersionUnsupported", (error) =>
      Effect.gen(function*() {
        yield* Effect.logInfo("Old server rejects the write before its handler runs", error.supported)
        return yield* save.pipe(
          Effect.provideService(VersionedSchema.ClientVersions, error.supported)
        )
      }))
  )
  // => HTTP request, Person=3      { _version: 3, fullName: "Ada", status: "active", email: "ada@example.com" }
  // => HTTP response, 400          VersionUnsupported { id: "Person", requested: 3, oldest: 1, supported: { Person: 1 } }
  // => Old server rejects the write before its handler runs { Person: 1 }
  // => HTTP request, Person=1      { _version: 1, name: "Ada", status: "active" }
  // => Old server handler receives { name: "Ada", status: "active" }
  // => HTTP response, 200          { _version: 1, name: "Ada", status: "active" }

  yield* Effect.logInfo("New client receives", saved)
  // => { fullName: "Ada", status: "active" }
})

// 3. A value the old client's version can't hold fails instead of being changed.
export const unrepresentable = Effect.gen(function*() {
  yield* Effect.logInfo("3. An archived person → an old client")
  const client = yield* HttpApiClient.make(Previous.Api, {
    transformClient: trace
  })

  // The new server can't write an archived person at v1, so the call fails with
  // a typed error after its handler has run.
  yield* client.people.getById({
    params: {
      id: "grace"
    }
  }).pipe(
    Effect.flatMap((person) => Effect.logInfo("Old client receives", person)),
    Effect.catchTag(
      "Unrepresentable",
      (error) =>
        Effect.logWarning("Old client can't show this person", {
          reason: error.reason
        })
    )
  )
  // => HTTP request, Person=1 (no body)
  // => New server returns     { fullName: "Grace", status: "archived" }
  // => HTTP response, 406     Unrepresentable { id: "Person", version: 1, reason: "Person can't be written at v1: ..." }
  // => Old client can't show this person { reason: "Person can't be written at v1: An archived person needs Person v3" }
})
