import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { VersionedSchema } from "effect/schema"
import { createServer } from "node:http"

const PersonV1 = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["active", "suspended"])
})

// The previous release only declared v1.
const PreviousPerson = VersionedSchema.make("Person", { version: 1, payload: PersonV1 })

// The current release renamed `name`, added an optional `email`, and added an
// `archived` status, which v1 can't hold.
const Person = VersionedSchema.make("Person", { version: 1, payload: PersonV1 }).next({
  version: 2,
  payload: Schema.Struct({
    fullName: Schema.String,
    status: Schema.Literals(["active", "suspended", "archived"]),
    email: Schema.optionalKey(Schema.String)
  }),
  migration: (step) =>
    step.renameField("name", "fullName").addField("email").mapField("status", {
      up: (status) => status,
      down: (status) =>
        status === "archived"
          ? VersionedSchema.unrepresentable("An archived person needs Person v2")
          : status
    })
})

type Person = typeof Person.Type

// The same RPCs in two releases. Each uses the Person schema it shipped with.
class PeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", { success: Person }),
  Rpc.make("SavePerson", { payload: { person: Person }, success: Person }),
  Rpc.make("ListPeople", { success: Person, stream: true })
) {}

class PreviousPeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", { success: PreviousPerson }),
  Rpc.make("SavePerson", { payload: { person: PreviousPerson }, success: PreviousPerson }),
  Rpc.make("ListPeople", { success: PreviousPerson, stream: true })
) {}

const ada: Person = { fullName: "Ada", status: "active", email: "ada@example.com" }
const grace: Person = { fullName: "Grace", status: "archived" }

const PeopleRpcHandlers = PeopleRpcs.toLayer({
  GetPerson: () => Effect.succeed(ada),
  SavePerson: Effect.fn(function*({ person }) {
    yield* Effect.logInfo("New RPC handler receives", person)
    return person
  }),
  ListPeople: () => Stream.make(ada, grace)
})

const PreviousPeopleRpcHandlers = PreviousPeopleRpcs.toLayer({
  GetPerson: () => Effect.succeed({ name: "Ada", status: "active" }),
  SavePerson: Effect.fn(function*({ person }) {
    yield* Effect.logInfo("Old RPC handler receives", person)
    return person
  }),
  ListPeople: () => Stream.make({ name: "Ada", status: "active" })
})

const RpcRoutes = RpcServer.layer(PeopleRpcs).pipe(
  Layer.provide(PeopleRpcHandlers),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" }))
)

const PreviousRpcRoutes = RpcServer.layer(PreviousPeopleRpcs).pipe(
  Layer.provide(PreviousPeopleRpcHandlers),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" }))
)

// HTTP servers on free loopback ports. The servers' own request logs are left
// out.
const HttpServerLayer = HttpRouter.serve(RpcRoutes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
)

const PreviousHttpServerLayer = HttpRouter.serve(PreviousRpcRoutes, { disableLogger: true, disableListenLog: true })
  .pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
  )

// Clients post to the /rpc route of whichever server is provided.
const RpcClientProtocol = Layer.unwrap(
  HttpServer.addressFormattedWith((url) => Effect.succeed(RpcClient.layerProtocolHttp({ url: `${url}/rpc` })))
).pipe(
  Layer.provide(FetchHttpClient.layer)
)

// An old client calls the upgraded server and keeps its own shape.
const oldClientNewServer = Effect.gen(function*() {
  const client = yield* RpcClient.make(PreviousPeopleRpcs)

  const read = yield* client.GetPerson()
  yield* Effect.logInfo("Old client reads from the new server", read)
  // => { name: "Ada", status: "active" }

  const saved = yield* client.SavePerson({ person: { name: "Ada", status: "active" } })
  // => New RPC handler receives { fullName: "Ada", status: "active" }

  yield* Effect.logInfo("Old client saves to the new server", saved)
  // => { name: "Ada", status: "active" }

  // Each item is written as it's sent: Ada arrives, then the stream fails at
  // Grace, whose archived status v1 can't hold.
  yield* client.ListPeople().pipe(
    Stream.runForEach((person) => Effect.logInfo("Old client receives a stream item", person)),
    Effect.catchTag(
      "Unrepresentable",
      (error) => Effect.logWarning("Stream ends at a person v1 can't hold", { reason: error.reason })
    )
  )
  // => Old client receives a stream item { name: "Ada", status: "active" }
  // => Stream ends at a person v1 can't hold { reason: "Person can't be written at v1: An archived person needs Person v2" }
}).pipe(
  Effect.scoped,
  Effect.provide(RpcClientProtocol),
  Effect.provide(HttpServerLayer)
)

// A new client calls a server that hasn't upgraded. Reads upgrade locally. The
// old server rejects a v2 write before its handler runs, and this application
// retries once at the server's versions, dropping email.
const newClientOldServer = Effect.gen(function*() {
  const client = yield* RpcClient.make(PeopleRpcs)

  const read = yield* client.GetPerson()
  yield* Effect.logInfo("New client reads from the old server", read)
  // => { fullName: "Ada", status: "active" }

  const save = client.SavePerson({ person: ada })
  const saved = yield* save.pipe(
    Effect.catchTag("VersionUnsupported", (error) =>
      Effect.gen(function*() {
        yield* Effect.logInfo("Old server rejects the write before its handler runs", error.supported)
        return yield* save.pipe(
          Effect.provideService(VersionedSchema.ClientVersions, error.supported)
        )
      }))
  )
  // => Old server rejects the write before its handler runs { Person: 1 }
  // => Old RPC handler receives { name: "Ada", status: "active" }

  yield* Effect.logInfo("New client receives", saved)
  // => { fullName: "Ada", status: "active" }
}).pipe(
  Effect.scoped,
  Effect.provide(RpcClientProtocol),
  Effect.provide(PreviousHttpServerLayer)
)

Effect.gen(function*() {
  yield* oldClientNewServer
  yield* newClientOldServer
}).pipe(
  Effect.provide(RpcSerialization.layerJson),
  Effect.timeout("30 seconds"),
  NodeRuntime.runMain
)
