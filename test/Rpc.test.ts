import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Api } from "../src/Api.ts"
import { Routes } from "../src/Http.ts"
import { PeopleRpcs } from "../src/People/Rpcs.ts"
import { ada } from "../src/People/Seed.ts"
import type { Person as LegacyPerson } from "./fixtures/legacy/Domain/Person.ts"
import { makeLegacyRpc } from "./fixtures/legacy/Rpc.ts"
import { PeopleRpcs as LegacyPeopleRpcs } from "./fixtures/legacy/Rpcs.ts"
import { ada as legacyAda } from "./fixtures/legacy/Seed.ts"
import { serve } from "./helpers/serve.ts"

test("RPC compatibility and partial stream delivery across schema histories", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const legacy = makeLegacyRpc()
      const currentUrl = yield* serve(Routes)
      const legacyUrl = yield* serve(legacy.routes)
      const transport = RpcClient.layerProtocolHttp({ url: `${currentUrl}/rpc` })
      const legacyTransport = RpcClient.layerProtocolHttp({ url: `${legacyUrl}/rpc` })

      const client = yield* RpcClient.make(PeopleRpcs).pipe(Effect.provide(transport))
      assert.deepEqual(yield* client.GetPerson({ id: "ada" }), ada)
      const updated = { ...ada, email: "ada.lovelace@example.com" }
      assert.deepEqual(yield* client.SavePerson({ id: "ada", person: updated }), updated)
      const http = yield* HttpApiClient.make(Api, { baseUrl: currentUrl })
      assert.deepEqual(yield* http.people.getById({ params: { id: "ada" } }), updated)
      yield* Effect.logInfo("RPC and HTTP share the People service")

      const oldClient = yield* RpcClient.make(LegacyPeopleRpcs).pipe(Effect.provide(transport))
      assert.deepEqual(yield* oldClient.GetPerson({ id: "ada" }), legacyAda)
      assert.deepEqual(yield* oldClient.SavePerson({ id: "ada", person: legacyAda }), legacyAda)
      yield* Effect.logInfo("Old RPC client reads and writes using its own Person schema")

      const newClient = yield* RpcClient.make(PeopleRpcs).pipe(Effect.provide(legacyTransport))
      const upgraded = { fullName: "Ada", status: "active", address: { street: "1 Main St" } }
      assert.deepEqual(yield* newClient.GetPerson({ id: "ada" }), upgraded)
      const save = newClient.SavePerson({ id: "ada", person: ada })
      const unsupported = yield* Effect.flip(save)
      assert.ok(unsupported instanceof VersionedSchema.VersionUnsupported)
      assert.deepEqual(unsupported.supported, { Address: 1, Person: 1 })
      assert.equal(legacy.calls.saves, 0)

      const retried = yield* save.pipe(Effect.catchTag("VersionUnsupported", (error) =>
        save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))))
      assert.deepEqual(retried, upgraded)
      assert.equal(legacy.calls.saves, 1)
      yield* Effect.logInfo("New RPC client explicitly retries at the old server's versions")

      // Ada is delivered before the stream fails at Grace's archived status.
      const received: Array<LegacyPerson> = []
      const failure = yield* oldClient.ListPeople().pipe(
        Stream.runForEach((person) =>
          Effect.sync(() => {
            received.push(person)
          })
        ),
        Effect.flip
      )
      assert.deepEqual(received, [legacyAda])
      assert.ok(failure instanceof VersionedSchema.Unrepresentable)
      yield* Effect.logInfo("Old client received part of the stream", received)
      yield* Effect.logInfo("Stream then failed with Unrepresentable", failure.reason)
    }).pipe(
      Effect.provide(RpcSerialization.layerJson),
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped,
      Effect.timeout("30 seconds")
    )
  ))
