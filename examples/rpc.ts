import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { VersionedSchema } from "effect/schema"
import { Person } from "../src/Domain/Person.ts"
import { serve } from "../src/Http.ts"
import * as Legacy from "../src/legacy.ts"

// The same RPCs in two releases. Each uses the Person schema it shipped with.
class PeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", { success: Person }),
  Rpc.make("SavePerson", { payload: { person: Person }, success: Person }),
  Rpc.make("ListPeople", { success: Person, stream: true })
) {}
class LegacyPeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", { success: Legacy.Person }),
  Rpc.make("SavePerson", { payload: { person: Legacy.Person }, success: Legacy.Person }),
  Rpc.make("ListPeople", { success: Legacy.Person, stream: true })
) {}

const ada: Person = { fullName: "Ada", status: "active", email: "ada@example.com" }
const grace: Person = { fullName: "Grace", status: "archived" }

const RpcRoutes = RpcServer.layer(PeopleRpcs).pipe(
  Layer.provide(PeopleRpcs.toLayer({
    GetPerson: () => Effect.succeed(ada),
    SavePerson: Effect.fn(function*({ person }) {
      yield* Effect.logInfo("New RPC handler receives", person)
      return person
    }),
    ListPeople: () => Stream.make(ada, grace)
  })),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" }))
)
const LegacyRpcRoutes = RpcServer.layer(LegacyPeopleRpcs).pipe(
  Layer.provide(LegacyPeopleRpcs.toLayer({
    GetPerson: () => Effect.succeed({ name: "Ada", status: "active" }),
    SavePerson: Effect.fn(function*({ person }) {
      yield* Effect.logInfo("Old RPC handler receives", person)
      return person
    }),
    ListPeople: () => Stream.make({ name: "Ada", status: "active" })
  })),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" }))
)

const client = <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>, baseUrl: string) =>
  RpcClient.make(group).pipe(Effect.provide(RpcClient.layerProtocolHttp({ url: `${baseUrl}/rpc` })))

Effect.gen(function*() {
  const currentUrl = yield* serve(RpcRoutes)
  const legacyUrl = yield* serve(LegacyRpcRoutes)

  // An old client calls the upgraded server and keeps its own shape.
  const old = yield* client(LegacyPeopleRpcs, currentUrl)
  yield* Effect.logInfo("Old client reads from the new server", yield* old.GetPerson())
  yield* Effect.logInfo(
    "Old client saves to the new server",
    yield* old.SavePerson({ person: { name: "Ada", status: "active" } })
  )

  // A new client calls a server that hasn't upgraded. Reads upgrade locally;
  // the write is rejected before the old handler runs, and this application
  // retries once at the server's versions, dropping email.
  const newer = yield* client(PeopleRpcs, legacyUrl)
  yield* Effect.logInfo("New client reads from the old server", yield* newer.GetPerson())
  const save = newer.SavePerson({ person: ada })
  const saved = yield* save.pipe(
    Effect.catchTag("VersionUnsupported", (error) =>
      Effect.logInfo("Old server rejects the write before its handler runs", error.supported).pipe(
        Effect.andThen(save.pipe(Effect.provideService(VersionedSchema.ClientVersions, error.supported)))
      ))
  )
  yield* Effect.logInfo("New client receives", saved)

  // Streams deliver each item as it encodes: Ada arrives, then the stream fails
  // at Grace, whose archived status v1 can't hold.
  yield* old.ListPeople().pipe(
    Stream.runForEach((person) => Effect.logInfo("Old client receives a stream item", person)),
    Effect.catchTag("Unrepresentable", (error) =>
      Effect.logWarning("Stream ends at a person v1 can't hold", { reason: error.reason }))
  )
}).pipe(
  Effect.provide(RpcSerialization.layerJson),
  Effect.provide(FetchHttpClient.layer),
  Effect.scoped,
  Effect.timeout("30 seconds"),
  NodeRuntime.runMain
)
