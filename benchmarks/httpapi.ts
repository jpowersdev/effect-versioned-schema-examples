// Times one HttpApi call through the generated client and an in-process server:
//
//   node benchmarks/httpapi.ts <get | save | build> <plain | versioned> [latest | v1]
//
// `build` times building the server and the client, and making the first call.
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { check, iterationsFor, layerInProcessClient, measure, parseArgs } from "./measure.ts"

const { call, schema, version } = parseArgs()
const { ada, Person, received, speaking } = schema === "versioned"
  ? await import("./versioned.ts")
  : await import("./plain.ts")

class Api extends HttpApi.make("api").add(
  HttpApiGroup.make("people").add(
    HttpApiEndpoint.get("getById", "/people/:id", {
      params: {
        id: Schema.String
      },
      success: Person
    }),
    HttpApiEndpoint.put("save", "/people/:id", {
      params: {
        id: Schema.String
      },
      payload: Person,
      success: Person
    })
  )
) {}

const PeopleApiHandlers = HttpApiBuilder.group(Api, "people", (handlers) =>
  Effect.succeed(handlers.handleAll({
    getById: () => Effect.succeed(ada),
    save: ({ payload }) => Effect.succeed(payload)
  })))

const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(PeopleApiHandlers),
  Layer.provide(HttpServer.layerServices)
)

// Builds the server and a client that sends requests straight to it.
const makeClient = Effect.gen(function*() {
  const { handler, dispose } = HttpRouter.toWebHandler(ApiRoutes, {
    disableLogger: true
  })
  yield* Effect.addFinalizer(() => Effect.promise(dispose))

  return yield* HttpApiClient.make(Api, {
    baseUrl: "http://localhost"
  }).pipe(
    Effect.provide(layerInProcessClient(handler))
  )
})

type Client = Effect.Success<typeof makeClient>

const request = (client: Client) =>
  (call === "save"
    ? client.people.save({
      params: {
        id: "ada"
      },
      payload: ada
    })
    : client.people.getById({
      params: {
        id: "ada"
      }
    })).pipe(
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
