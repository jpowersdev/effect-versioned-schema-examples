import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"
import { serve } from "../serve.ts"
import { PeopleV1, PeopleV3 } from "./protocol.ts"
import { makeServers } from "./server.ts"

const demo = Effect.gen(function*() {
  const servers = makeServers()
  const currentUrl = yield* serve(servers.current)
  const oldUrl = yield* serve(servers.old)
  const currentTransport = RpcClient.layerProtocolHttp({ url: `${currentUrl}/rpc` })
  const oldTransport = RpcClient.layerProtocolHttp({ url: `${oldUrl}/rpc` })

  const current = yield* RpcClient.make(PeopleV3).pipe(Effect.provide(currentTransport))
  assert.deepEqual(yield* current.GetPerson({ id: "ada" }), V3.ada)
  console.log("v3 RPC client → v3 server:", V3.ada)

  const old = yield* RpcClient.make(PeopleV1).pipe(Effect.provide(currentTransport))
  assert.deepEqual(yield* old.GetPerson({ id: "ada" }), V1.ada)
  assert.deepEqual(yield* old.SavePerson({ person: V1.ada }), V1.ada)
  console.log("v1 RPC client → v3 server: old request and reply shapes")

  const newer = yield* RpcClient.make(PeopleV3).pipe(Effect.provide(oldTransport))
  const upgraded = { fullName: "Ada", status: "active", address: { street: "1 Main St" } }
  assert.deepEqual(yield* newer.GetPerson({ id: "ada" }), upgraded)
  const save = newer.SavePerson({ person: V3.ada })
  const unsupported = yield* Effect.flip(save)
  assert.ok(unsupported instanceof VersionedSchema.VersionUnsupported)
  assert.equal(servers.calls.oldSaves, 0)
  console.log("v3 RPC write → v1 server:", unsupported._tag, unsupported.supported)

  const retried = yield* save.pipe(
    Effect.catchTag(
      "VersionUnsupported",
      (error) => save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))
    )
  )
  assert.deepEqual(retried, upgraded)
  assert.equal(servers.calls.oldSaves, 1)
  console.log("Explicit RPC retry succeeded:", retried)

  // The first value is delivered. The stream ends with a typed failure at the
  // archived person, which an old client cannot represent.
  const received: Array<typeof V1.Person.Type> = []
  const failure = yield* old.ListPeople().pipe(
    Stream.runForEach((person) =>
      Effect.sync(() => {
        received.push(person)
      })
    ),
    Effect.flip
  )
  assert.deepEqual(received, [V1.ada])
  assert.ok(failure instanceof VersionedSchema.Unrepresentable)
  console.log("v1 RPC stream received:", received)
  console.log("Then ended with:", failure._tag, failure.reason)
  console.log("RPC examples passed.")
})

await Effect.runPromise(demo.pipe(
  Effect.provide(RpcSerialization.layerJson),
  Effect.provide(FetchHttpClient.layer),
  Effect.scoped,
  Effect.timeout("30 seconds")
))
