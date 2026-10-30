import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import { Person } from "../src/Domain/Person.ts"
import { Person as LegacyPerson } from "../src/legacy.ts"
import { serve } from "../src/People/Http.ts"

// The same contract in two deployments. Each uses the Person schema it knows.
class PeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", { success: Person }),
  Rpc.make("SavePerson", { payload: { person: Person }, success: Person }),
  Rpc.make("ListPeople", { success: Person, stream: true })
) {}
class LegacyPeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", { success: LegacyPerson }),
  Rpc.make("SavePerson", { payload: { person: LegacyPerson }, success: LegacyPerson }),
  Rpc.make("ListPeople", { success: LegacyPerson, stream: true })
) {}

const ada: Person = { fullName: "Ada", status: "active", email: "ada@example.com" }
const grace: Person = { fullName: "Grace", status: "archived" }
const legacyAda: LegacyPerson = { name: "Ada", status: "active" }

Effect.gen(function*() {
  let oldSaves = 0
  const routes = RpcServer.layer(PeopleRpcs).pipe(
    Layer.provide(PeopleRpcs.toLayer({
      GetPerson: () => Effect.succeed(ada),
      SavePerson: Effect.fn(function*({ person }) {
        yield* Effect.logInfo("New RPC handler receives", person)
        return person
      }),
      ListPeople: () => Stream.make(ada, grace)
    })),
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson)
  )
  const legacyRoutes = RpcServer.layer(LegacyPeopleRpcs).pipe(
    Layer.provide(LegacyPeopleRpcs.toLayer({
      GetPerson: () => Effect.succeed(legacyAda),
      SavePerson: Effect.fn(function*({ person }) {
        oldSaves++
        yield* Effect.logInfo("Old RPC handler receives", person)
        return person
      }),
      ListPeople: () => Stream.make(legacyAda)
    })),
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson)
  )
  const currentUrl = yield* serve(routes)
  const legacyUrl = yield* serve(legacyRoutes)
  const transport = RpcClient.layerProtocolHttp({ url: `${currentUrl}/rpc` })
  const legacyTransport = RpcClient.layerProtocolHttp({ url: `${legacyUrl}/rpc` })

  const current = yield* RpcClient.make(PeopleRpcs).pipe(Effect.provide(transport))
  assert.deepEqual(yield* current.GetPerson(), ada)
  const old = yield* RpcClient.make(LegacyPeopleRpcs).pipe(Effect.provide(transport))
  const oldRead = yield* old.GetPerson()
  const oldReply = yield* old.SavePerson({ person: legacyAda })
  assert.deepEqual(oldRead, legacyAda)
  assert.deepEqual(oldReply, legacyAda)
  yield* Effect.logInfo("Old RPC client → new server: old shape preserved", oldReply)

  const newer = yield* RpcClient.make(PeopleRpcs).pipe(Effect.provide(legacyTransport))
  const read = yield* newer.GetPerson()
  assert.deepEqual(read, { fullName: "Ada", status: "active" })
  yield* Effect.logInfo("New RPC client upgrades an old server's reply", read)
  const save = newer.SavePerson({ person: ada })
  const retried = yield* save.pipe(Effect.catchTag(
    "VersionUnsupported",
    Effect.fn(function*(error) {
      assert.equal(oldSaves, 0)
      assert.deepEqual(error.supported, { Person: 1 })
      yield* Effect.logInfo("RPC write rejected before handler; explicitly retrying once", error.supported)
      return yield* save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))
    })
  ))
  assert.deepEqual(retried, read)
  assert.equal(oldSaves, 1)
  yield* Effect.logInfo("Retry succeeded; email was dropped", retried)

  // Delivery is incremental: Ada arrives before Grace's status fails to encode.
  const received: Array<LegacyPerson> = []
  const failure = yield* old.ListPeople().pipe(
    Stream.runForEach((person) =>
      Effect.gen(function*() {
        received.push(person)
        yield* Effect.logInfo("Old client receives stream item", person)
      })
    ),
    Effect.flip
  )
  assert.deepEqual(received, [legacyAda])
  assert.ok(failure instanceof VersionedSchema.Unrepresentable)
  yield* Effect.logInfo("Stream ends with Unrepresentable at the archived person", failure.reason)
}).pipe(
  Effect.provide(RpcSerialization.layerJson),
  Effect.provide(FetchHttpClient.layer),
  Effect.scoped,
  Effect.timeout("30 seconds"),
  NodeRuntime.runMain
)
