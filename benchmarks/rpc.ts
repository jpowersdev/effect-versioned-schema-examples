// Times one Rpc call through RpcClient and an in-process RpcServer over HTTP:
//
//   node benchmarks/rpc.ts <get | save | build> <plain | versioned> [latest | v1]
//
// `build` times building the server and the client, and making the first call.
// Cluster entities use the same client and server, so this covers their
// negotiation too, though not their message storage.
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { check, iterationsFor, layerInProcessClient, measure, parseArgs } from "./measure.ts"

const { call, schema, version } = parseArgs()
const { ada, Person, received, speaking } = schema === "versioned"
  ? await import("./versioned.ts")
  : await import("./plain.ts")

class PeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", {
    success: Person
  }),
  Rpc.make("SavePerson", {
    payload: {
      person: Person
    },
    success: Person
  })
) {}

const PeopleRpcHandlers = PeopleRpcs.toLayer({
  GetPerson: () => Effect.succeed(ada),
  SavePerson: ({ person }) => Effect.succeed(person)
})

const RpcRoutes = RpcServer.layer(PeopleRpcs).pipe(
  Layer.provide(PeopleRpcHandlers),
  Layer.provide(RpcServer.layerProtocolHttp({
    path: "/rpc"
  })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(HttpServer.layerServices)
)

// Builds the server and a client that sends requests straight to it.
const makeClient = Effect.gen(function*() {
  const { handler, dispose } = HttpRouter.toWebHandler(RpcRoutes, {
    disableLogger: true
  })
  yield* Effect.addFinalizer(() => Effect.promise(dispose))

  return yield* RpcClient.make(PeopleRpcs).pipe(
    Effect.provide(RpcClient.layerProtocolHttp({
      url: "http://localhost/rpc"
    })),
    Effect.provide(RpcSerialization.layerJson),
    Effect.provide(layerInProcessClient(handler))
  )
})

type Client = Effect.Success<typeof makeClient>

const request = (client: Client) =>
  (call === "save"
    ? client.SavePerson({
      person: ada
    })
    : client.GetPerson()).pipe(
      speaking(version)
    )

const program = Effect.gen(function*() {
  if (call === "build") {
    const build = Effect.scoped(Effect.flatMap(makeClient, request))
    yield* check(build, received(version))
    return yield* measure(build, iterationsFor(call))
  }

  const client = yield* makeClient
  yield* check(request(client), received(version))
  return yield* measure(request(client), iterationsFor(call))
})

const result = await Effect.runPromise(Effect.scoped(program))
console.log(JSON.stringify(result))
