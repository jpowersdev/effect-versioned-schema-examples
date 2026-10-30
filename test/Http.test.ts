import { Effect, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import { test } from "node:test"
import { oldClient, oldServer, unrepresentable } from "../src/client.ts"
import { PersonNotFound } from "../src/Domain/Person.ts"
import { Api } from "../src/People/Api.ts"
import { LegacyRoutes, Routes, serve } from "../src/People/Http.ts"

const capture = (messages: Array<Array<unknown>>) =>
  Logger.layer([Logger.make(({ message }) => {
    assert.ok(Array.isArray(message))
    messages.push(message)
  })])

const values = (messages: Array<Array<unknown>>, label: string) =>
  messages.filter((message) => message[0] === label).map((message) => message[1])

test("old client: real v1 wire body, current handler, v1 reply, stored update", () => {
  const messages: Array<Array<unknown>> = []
  return Effect.runPromise(
    Effect.gen(function*() {
      const url = yield* serve(Routes)
      const { sent, received } = yield* oldClient(url)
      assert.deepEqual(received, sent)
      assert.deepEqual(values(messages, "New server handler receives"), [{
        fullName: "Ada Lovelace",
        status: "active"
      }])
      assert.deepEqual(values(messages, "HTTP request"), [{
        method: "PUT",
        versions: "Person=1",
        body: { _version: 1, ...sent }
      }])
      assert.deepEqual(values(messages, "HTTP response"), [{ status: 200, body: { _version: 1, ...sent } }])
      const current = yield* HttpApiClient.make(Api, { baseUrl: url })
      assert.deepEqual(yield* current.people.getById({ params: { id: "ada" } }), {
        fullName: "Ada Lovelace",
        status: "active"
      })
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(capture(messages)),
      Effect.scoped,
      Effect.timeout("30 seconds")
    )
  )
})

test("old server: locally upgraded read, rejection before handler, exactly one retry", () => {
  const messages: Array<Array<unknown>> = []
  return Effect.runPromise(
    Effect.gen(function*() {
      const result = yield* oldServer(yield* serve(LegacyRoutes))
      assert.deepEqual(result.read, { fullName: "Ada", status: "active" })
      assert.ok(result.unsupported instanceof VersionedSchema.VersionUnsupported)
      assert.deepEqual(result.unsupported.supported, { Person: 1 })
      assert.deepEqual(result.received, result.read)
      const wireRead = { _version: 1, name: "Ada", status: "active" }
      assert.deepEqual(values(messages, "HTTP request"), [
        { method: "GET", versions: "Person=3", body: undefined },
        {
          method: "PUT",
          versions: "Person=3",
          body: { _version: 3, fullName: "Ada", status: "active", email: "ada@example.com" }
        },
        { method: "PUT", versions: "Person=1", body: wireRead }
      ])
      assert.deepEqual(values(messages, "HTTP response"), [
        { status: 200, body: wireRead },
        {
          status: 400,
          body: { _tag: "VersionUnsupported", id: "Person", requested: 3, oldest: 1, supported: { Person: 1 } }
        },
        { status: 200, body: wireRead }
      ])
      assert.deepEqual(values(messages, "Old server handler receives"), [{ name: "Ada", status: "active" }])
      const rejected = messages.findIndex((message) => message[0] === "Rejected before the handler: VersionUnsupported")
      const handled = messages.findIndex((message) => message[0] === "Old server handler receives")
      assert.ok(rejected >= 0 && handled > rejected)
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(capture(messages)),
      Effect.scoped,
      Effect.timeout("30 seconds")
    )
  )
})

test("unrepresentable: archived value fails with a typed 406, with no retry", () => {
  const messages: Array<Array<unknown>> = []
  return Effect.runPromise(
    Effect.gen(function*() {
      const failure = yield* unrepresentable(yield* serve(Routes))
      assert.ok(failure instanceof VersionedSchema.Unrepresentable)
      assert.deepEqual(values(messages, "New server returns"), [{ fullName: "Grace", status: "archived" }])
      assert.equal(values(messages, "HTTP request").length, 1)
      assert.deepEqual(values(messages, "HTTP response"), [{
        status: 406,
        body: {
          _tag: "Unrepresentable",
          id: "Person",
          version: 1,
          reason: failure.reason
        }
      }])
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(capture(messages)),
      Effect.scoped,
      Effect.timeout("30 seconds")
    )
  )
})

test("current clients retain current fields, and missing people remain domain errors", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* HttpApiClient.make(Api, { baseUrl: yield* serve(Routes) })
      const person = { fullName: "Ada", status: "active" as const, email: "ada@example.com" }
      assert.deepEqual(yield* client.people.save({ params: { id: "ada" }, payload: person }), person)
      assert.deepEqual(yield* client.people.getById({ params: { id: "ada" } }), person)
      assert.ok((yield* Effect.flip(client.people.getById({ params: { id: "missing" } }))) instanceof PersonNotFound)
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped, Effect.timeout("30 seconds"))
  ))
