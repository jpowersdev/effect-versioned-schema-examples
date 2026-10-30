import { assert, layer } from "@effect/vitest"
import { Effect, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { oldClient, oldServer, unrepresentable } from "../src/client.ts"
import { PersonNotFound } from "../src/Domain/Person.ts"
import { ApiRoutes, serve } from "../src/Http.ts"
import * as Legacy from "../src/legacy.ts"
import { Api } from "../src/People/Api.ts"

// Runs a scenario and returns what it logged, as [label, value] pairs.
const logged = <E, R>(scenario: Effect.Effect<void, E, R>) =>
  Effect.gen(function*() {
    const messages: Array<ReadonlyArray<unknown>> = []
    yield* scenario.pipe(
      Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message as ReadonlyArray<unknown>))]))
    )
    return (label: string) => messages.filter((message) => message[0] === label).map((message) => message[1])
  })

layer(FetchHttpClient.layer)("HTTP scenarios", (it) => {
  it.effect("an old client keeps its shape while the new handler sees the current one", () =>
    Effect.gen(function*() {
      const log = yield* logged(Effect.flatMap(serve(ApiRoutes), oldClient))
      const wire = { _version: 1, name: "Ada Lovelace", status: "active" }
      assert.deepStrictEqual(log("HTTP request"), [{ method: "PUT", versions: "Person=1", body: wire }])
      assert.deepStrictEqual(log("New server handler receives"), [{ fullName: "Ada Lovelace", status: "active" }])
      assert.deepStrictEqual(log("HTTP response"), [{ status: 200, body: wire }])
      assert.deepStrictEqual(log("Old client receives"), [{ name: "Ada Lovelace", status: "active" }])
    }))

  it.effect("a new client reads from an old server and retries a rejected write once", () =>
    Effect.gen(function*() {
      const log = yield* logged(Effect.flatMap(serve(Legacy.ApiRoutes), oldServer))
      const wire = { _version: 1, name: "Ada", status: "active" }
      assert.deepStrictEqual(log("HTTP request"), [
        { method: "GET", versions: "Person=3", body: undefined },
        {
          method: "PUT",
          versions: "Person=3",
          body: { _version: 3, fullName: "Ada", status: "active", email: "ada@example.com" }
        },
        { method: "PUT", versions: "Person=1", body: wire }
      ])
      assert.deepStrictEqual(log("HTTP response"), [
        { status: 200, body: wire },
        {
          status: 400,
          body: { _tag: "VersionUnsupported", id: "Person", requested: 3, oldest: 1, supported: { Person: 1 } }
        },
        { status: 200, body: wire }
      ])
      // The old handler only ran for the retry
      assert.deepStrictEqual(log("Old server handler receives"), [{ name: "Ada", status: "active" }])
      assert.deepStrictEqual(log("New client receives"), [{ fullName: "Ada", status: "active" }])
    }))

  it.effect("an archived person fails for an old client with a typed 406", () =>
    Effect.gen(function*() {
      const log = yield* logged(Effect.flatMap(serve(ApiRoutes), unrepresentable))
      assert.deepStrictEqual(log("New server returns"), [{ fullName: "Grace", status: "archived" }])
      const [{ reason }] = log("Old client can't show this person") as [{ reason: string }]
      assert.include(reason, "An archived person needs Person v3")
      assert.deepStrictEqual(log("HTTP response"), [{
        status: 406,
        body: { _tag: "Unrepresentable", id: "Person", version: 1, reason }
      }])
      assert.deepStrictEqual(log("Old client receives"), [])
    }))

  it.effect("current clients keep every field, and missing people stay domain errors", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiClient.make(Api, { baseUrl: yield* serve(ApiRoutes) })
      const ada = { fullName: "Ada", status: "active" as const, email: "ada@example.com" }
      assert.deepStrictEqual(yield* client.people.save({ params: { id: "ada" }, payload: ada }), ada)
      assert.deepStrictEqual(yield* client.people.getById({ params: { id: "ada" } }), ada)
      const missing = yield* Effect.flip(client.people.getById({ params: { id: "missing" } }))
      assert.instanceOf(missing, PersonNotFound)
    }))
})
