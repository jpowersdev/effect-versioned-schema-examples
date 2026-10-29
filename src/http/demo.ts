import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"
import { serve } from "../serve.ts"
import { ApiV1, ApiV3 } from "./api.ts"
import { makeServers } from "./server.ts"

const demo = Effect.gen(function*() {
  const servers = makeServers()
  const currentUrl = yield* serve(servers.current)
  const oldUrl = yield* serve(servers.old)

  const current = yield* HttpApiClient.make(ApiV3, { baseUrl: currentUrl })
  assert.deepEqual(yield* current.people.get({ params: { id: "ada" } }), V3.ada)
  console.log("v3 client → v3 server: fullName, email and city")

  const old = yield* HttpApiClient.make(ApiV1, { baseUrl: currentUrl })
  assert.deepEqual(yield* old.people.get({ params: { id: "ada" } }), V1.ada)
  assert.deepEqual(yield* old.people.save({ payload: V1.ada }), V1.ada)
  console.log("v1 client → v3 server: name; reads and writes work")

  const newer = yield* HttpApiClient.make(ApiV3, { baseUrl: oldUrl })
  const upgraded = { fullName: "Ada", status: "active", address: { street: "1 Main St" } }
  assert.deepEqual(yield* newer.people.get({ params: { id: "ada" } }), upgraded)
  console.log("v3 client → v1 server: response-only read upgrades locally")

  const save = newer.people.save({ payload: V3.ada })
  const unsupported = yield* Effect.flip(save)
  assert.ok(unsupported instanceof VersionedSchema.VersionUnsupported)
  assert.deepEqual(unsupported.supported, { Address: 1, Person: 1 })
  assert.equal(servers.calls.oldSaves, 0)
  console.log("v3 write → v1 server rejected before handler:", unsupported._tag, unsupported.supported)

  // Retrying is application policy. This one retry is explicit and only handles
  // VersionUnsupported, which rejects before running the handler.
  const retried = yield* save.pipe(
    Effect.catchTag(
      "VersionUnsupported",
      (error) => save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))
    )
  )
  assert.deepEqual(retried, upgraded)
  assert.equal(servers.calls.oldSaves, 1)
  console.log("Explicit retry at the server's versions:", retried)

  const unrepresentable = yield* Effect.flip(old.people.get({ params: { id: "archived" } }))
  assert.ok(unrepresentable instanceof VersionedSchema.Unrepresentable)
  console.log("Archived value → v1 client:", unrepresentable._tag, unrepresentable.reason)

  const raw = yield* Effect.promise(() =>
    fetch(`${currentUrl}/people/ada`, {
      headers: { [VersionedSchema.header]: "Address=1, Person=1" }
    }).then((response) => response.json())
  )
  assert.deepEqual(raw, { _version: 1, name: "Ada", status: "active", address: { _version: 1, street: "1 Main St" } })
  console.log("Actual HTTP response body for v1:", raw)
  console.log("HTTP examples passed.")
})

await Effect.runPromise(demo.pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped, Effect.timeout("30 seconds")))
