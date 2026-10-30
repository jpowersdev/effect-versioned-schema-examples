import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Ref, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { VersionedSchema } from "effect/schema"

// The API as it shipped before versioning. Clients built from it send no
// version header, and its stored records have no `_version`.
const PreviousCustomer = Schema.Struct({ name: Schema.String })

class PreviousApi extends HttpApi.make("api").add(
  HttpApiGroup.make("customers").add(
    HttpApiEndpoint.get("get", "/customer", { success: PreviousCustomer }),
    HttpApiEndpoint.put("save", "/customer", { payload: PreviousCustomer, success: PreviousCustomer })
  )
) {}

// Adopting versioning: the shape already in use becomes v1, read and written
// without `_version`, and the rename becomes v2.
const Customer = VersionedSchema.make("Customer", {
  version: 1,
  payload: Schema.Struct({ name: Schema.String }),
  unversioned: true
}).next({
  version: 2,
  payload: Schema.Struct({ fullName: Schema.String }),
  migration: (step) => step.renameField("name", "fullName")
})

class Api extends HttpApi.make("api").add(
  HttpApiGroup.make("customers").add(
    HttpApiEndpoint.get("get", "/customer", { success: Customer }),
    HttpApiEndpoint.put("save", "/customer", { payload: Customer, success: Customer })
  )
) {}

const CustomersApiHandlers = HttpApiBuilder.group(
  Api,
  "customers",
  Effect.fn(function*(handlers) {
    // A record stored before versioning reads as v1, upgraded to the current shape.
    const stored = { name: "Ada" }
    const initial = yield* Schema.decodeUnknownEffect(Customer)(stored)
    const customer = yield* Ref.make(initial)

    return handlers.handleAll({
      get: () => Ref.get(customer),
      save: Effect.fn(function*({ payload }) {
        yield* Effect.logInfo("Server handler receives", payload)
        return yield* Ref.setAndGet(customer, payload)
      })
    })
  })
)

const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(CustomersApiHandlers)
)

// An HTTP server on a free port, with an HttpClient that sends requests to it.
// The server's own request logs are left out.
const HttpServerLayer = HttpRouter.serve(ApiRoutes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest)
)

// The same server, answering requests without the header at Customer v1 instead
// of the latest version. Remove the pin once every client sends the header.
const PinnedHttpServerLayer = HttpServerLayer.pipe(
  Layer.provide(Layer.succeed(VersionedSchema.DefaultVersions, Customer.version(1)))
)

// By default, a request without the header gets the latest version, so a
// previous client can't read the response.
const withoutPin = Effect.gen(function*() {
  const previous = yield* HttpApiClient.make(PreviousApi)

  yield* previous.customers.get().pipe(
    Effect.flatMap((customer) => Effect.logInfo("Previous client reads", customer)),
    Effect.catchTag("SchemaError", () => Effect.logWarning("Previous client can't read the latest version"))
  )
  // => Previous client can't read the latest version
}).pipe(
  Effect.provide(HttpServerLayer)
)

const withPin = Effect.gen(function*() {
  const previous = yield* HttpApiClient.make(PreviousApi)

  const read = yield* previous.customers.get()
  yield* Effect.logInfo("Previous client reads, with the pin", read)
  // => { name: "Ada" }

  // The server upgrades the write, and answers it at v1.
  const saved = yield* previous.customers.save({ payload: { name: "Ada Lovelace" } })
  // => Server handler receives { fullName: "Ada Lovelace" }

  yield* Effect.logInfo("Previous client saves, with the pin", saved)
  // => { name: "Ada Lovelace" }

  // A client built with the versioned contract sends the header, so the pin
  // doesn't apply to it.
  const current = yield* HttpApiClient.make(Api)

  const currentRead = yield* current.customers.get()
  yield* Effect.logInfo("Current client reads", currentRead)
  // => { fullName: "Ada Lovelace" }
}).pipe(
  Effect.provide(PinnedHttpServerLayer)
)

Effect.gen(function*() {
  yield* withoutPin
  yield* withPin
}).pipe(
  Effect.timeout("30 seconds"),
  NodeRuntime.runMain
)
