import { assert, describe, it } from "@effect/vitest"
import { Effect, Logger } from "effect"
import { HttpApiClient } from "effect/http-api"
import { oldClient, oldServer, unrepresentable } from "../src/client.ts"
import { type Person, PersonNotFound } from "../src/Domain/Person.ts"
import { HttpServerLayer } from "../src/Http.ts"
import { Api } from "../src/People/Api.ts"
import * as Previous from "../src/previous.ts"

// Runs a scenario with its logs captured. Returns a lookup from a log label to
// the values logged with it, in order.
const captureLogs = <E, R>(scenario: Effect.Effect<void, E, R>) =>
  Effect.gen(function*() {
    const messages: Array<ReadonlyArray<unknown>> = []
    const CaptureLoggerLayer = Logger.layer([
      Logger.make(({ message }) => {
        messages.push(message as ReadonlyArray<unknown>)
      })
    ])

    yield* scenario.pipe(Effect.provide(CaptureLoggerLayer))

    return (label: string) => messages.filter((message) => message[0] === label).map((message) => message[1])
  })

describe("HTTP scenarios", () => {
  it.effect("an old client keeps its shape while the new handler sees the current one", () =>
    Effect.gen(function*() {
      const logged = yield* captureLogs(oldClient.pipe(Effect.provide(HttpServerLayer)))
      const wire = {
        _version: 1,
        name: "Ada Lovelace",
        status: "active"
      }

      assert.deepStrictEqual(logged("HTTP request"), [{
        method: "PUT",
        versions: "Person=1",
        body: wire
      }])
      assert.deepStrictEqual(logged("New server handler receives"), [{
        fullName: "Ada Lovelace",
        status: "active"
      }])
      assert.deepStrictEqual(logged("HTTP response"), [{
        status: 200,
        body: wire
      }])
      assert.deepStrictEqual(logged("Old client receives"), [{
        name: "Ada Lovelace",
        status: "active"
      }])
    }))

  it.effect("a new client reads from an old server and retries a rejected write once", () =>
    Effect.gen(function*() {
      const logged = yield* captureLogs(oldServer.pipe(Effect.provide(Previous.HttpServerLayer)))
      const wire = {
        _version: 1,
        name: "Ada",
        status: "active"
      }

      assert.deepStrictEqual(logged("HTTP request"), [
        {
          method: "GET",
          versions: "Person=3",
          body: undefined
        },
        {
          method: "PUT",
          versions: "Person=3",
          body: {
            _version: 3,
            fullName: "Ada",
            status: "active",
            email: "ada@example.com"
          }
        },
        {
          method: "PUT",
          versions: "Person=1",
          body: wire
        }
      ])
      assert.deepStrictEqual(logged("HTTP response"), [
        {
          status: 200,
          body: wire
        },
        {
          status: 400,
          body: {
            _tag: "VersionUnsupported",
            id: "Person",
            requested: 3,
            oldest: 1,
            supported: {
              Person: 1
            }
          }
        },
        {
          status: 200,
          body: wire
        }
      ])

      // The old handler only ran for the retry
      assert.deepStrictEqual(logged("Old server handler receives"), [{
        name: "Ada",
        status: "active"
      }])
      assert.deepStrictEqual(logged("New client receives"), [{
        fullName: "Ada",
        status: "active"
      }])
    }))

  it.effect("an archived person fails for an old client with a typed 406", () =>
    Effect.gen(function*() {
      const logged = yield* captureLogs(unrepresentable.pipe(Effect.provide(HttpServerLayer)))
      assert.deepStrictEqual(logged("New server returns"), [{
        fullName: "Grace",
        status: "archived"
      }])

      const [{ reason }] = logged("Old client can't show this person") as [{
        reason: string
      }]
      assert.include(reason, "An archived person needs Person v3")

      assert.deepStrictEqual(logged("HTTP response"), [
        {
          status: 406,
          body: {
            _tag: "Unrepresentable",
            id: "Person",
            version: 1,
            reason
          }
        }
      ])
      assert.deepStrictEqual(logged("Old client receives"), [])
    }))

  it.effect("current clients keep every field, and missing people stay domain errors", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiClient.make(Api)

      const ada: Person = {
        fullName: "Ada",
        status: "active",
        email: "ada@example.com"
      }
      const saved = yield* client.people.save({
        params: {
          id: "ada"
        },
        payload: ada
      })
      assert.deepStrictEqual(saved, ada)

      const fetched = yield* client.people.getById({
        params: {
          id: "ada"
        }
      })
      assert.deepStrictEqual(fetched, ada)

      const missing = yield* client.people.getById({
        params: {
          id: "missing"
        }
      }).pipe(Effect.flip)
      assert.instanceOf(missing, PersonNotFound)
    }).pipe(Effect.provide(HttpServerLayer)))
})
