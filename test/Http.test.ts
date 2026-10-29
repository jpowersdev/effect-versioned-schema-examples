import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Api } from "../src/Api.ts"
import { PersonNotFound } from "../src/Domain/Person.ts"
import { Routes } from "../src/Http.ts"
import { ada } from "../src/People/Seed.ts"
import { Api as LegacyApi } from "./fixtures/legacy/Api.ts"
import { makeLegacyHttp } from "./fixtures/legacy/Http.ts"
import { ada as legacyAda } from "./fixtures/legacy/Seed.ts"
import { serve } from "./helpers/serve.ts"

test("HTTP compatibility across independently deployed schema histories", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const legacy = makeLegacyHttp()
      const currentUrl = yield* serve(Routes)
      const legacyUrl = yield* serve(legacy.routes)

      const client = yield* HttpApiClient.make(Api, { baseUrl: currentUrl })
      assert.deepEqual(yield* client.people.getById({ params: { id: "ada" } }), ada)
      const updated = { ...ada, email: "ada.lovelace@example.com" }
      assert.deepEqual(yield* client.people.save({ params: { id: "ada" }, payload: updated }), updated)
      assert.deepEqual(yield* client.people.getById({ params: { id: "ada" } }), updated)
      const missing = yield* Effect.flip(client.people.getById({ params: { id: "missing" } }))
      assert.ok(missing instanceof PersonNotFound)
      yield* Effect.logInfo("Current client reads and updates a person")

      const oldClient = yield* HttpApiClient.make(LegacyApi, { baseUrl: currentUrl })
      assert.deepEqual(yield* oldClient.people.getById({ params: { id: "ada" } }), legacyAda)
      assert.deepEqual(yield* oldClient.people.save({ params: { id: "ada" }, payload: legacyAda }), legacyAda)
      const upgraded = { fullName: "Ada", status: "active", address: { street: "1 Main St" } }
      assert.deepEqual(yield* client.people.getById({ params: { id: "ada" } }), upgraded)
      yield* Effect.logInfo("Old client writes are upgraded before reaching the People service")

      const newClient = yield* HttpApiClient.make(Api, { baseUrl: legacyUrl })
      assert.deepEqual(yield* newClient.people.getById({ params: { id: "ada" } }), upgraded)

      const save = newClient.people.save({ params: { id: "ada" }, payload: ada })
      const unsupported = yield* Effect.flip(save)
      assert.ok(unsupported instanceof VersionedSchema.VersionUnsupported)
      assert.deepEqual(unsupported.supported, { Address: 1, Person: 1 })
      assert.equal(legacy.calls.saves, 0)
      yield* Effect.logInfo("New write rejected by the old server before its handler runs", unsupported.supported)

      // One explicit retry. VersionUnsupported is rejected before the handler;
      // Unrepresentable may happen after a side effect and is not retried.
      const retried = yield* save.pipe(Effect.catchTag("VersionUnsupported", (error) =>
        save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))))
      assert.deepEqual(retried, upgraded)
      assert.equal(legacy.calls.saves, 1)
      yield* Effect.logInfo("Explicit retry at the server's versions succeeded")

      const unrepresentable = yield* Effect.flip(oldClient.people.getById({ params: { id: "grace" } }))
      assert.ok(unrepresentable instanceof VersionedSchema.Unrepresentable)
      yield* Effect.logInfo("Archived person cannot be sent to an old client", unrepresentable.reason)

      const http = yield* HttpClient.HttpClient
      const response = yield* http.execute(
        HttpClientRequest.get(`${currentUrl}/people/ada`).pipe(
          HttpClientRequest.setHeader(VersionedSchema.header, "Address=1, Person=1")
        )
      )
      assert.equal(response.status, 200)
      const raw = yield* response.json
      assert.deepEqual(raw, {
        _version: 1,
        name: "Ada",
        status: "active",
        address: { _version: 1, street: "1 Main St" }
      })
      yield* Effect.logInfo("Actual response body for an old client", raw)
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped, Effect.timeout("30 seconds"))
  ))
