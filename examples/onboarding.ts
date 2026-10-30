import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Ref, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { VersionedSchema } from "effect/schema"
import { serve } from "../src/Http.ts"

// An app that shipped before it used versioning. Its installed clients send no
// version header, and its database holds records without `_version`.
const InstalledCustomer = Schema.Struct({ name: Schema.String })

class InstalledApi extends HttpApi.make("api").add(
  HttpApiGroup.make("customers").add(
    HttpApiEndpoint.get("get", "/customer", { success: InstalledCustomer }),
    HttpApiEndpoint.put("save", "/customer", { payload: InstalledCustomer, success: InstalledCustomer })
  )
) {}

// Adopting versioning: the shape already in use becomes v1, read without
// `_version`, and the rename becomes v2.
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
        yield* Ref.set(customer, payload)
        return payload
      })
    })
  })
)

const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(CustomersApiHandlers)
)

Effect.gen(function*() {
  // By default, a request without the header gets the latest version, which is
  // how servers answer today. An installed client can't read v2.
  const unpinnedUrl = yield* serve(ApiRoutes)
  const unpinned = yield* HttpApiClient.make(InstalledApi, { baseUrl: unpinnedUrl })

  yield* unpinned.customers.get().pipe(
    Effect.flatMap((customer) => Effect.logInfo("Installed client reads", customer)),
    Effect.catch((error) => Effect.logWarning("Installed client can't read the latest version", error.message))
  )

  // Until every installed client sends the header, pin the version that
  // requests without it get. Remove the pin afterwards, and they get the latest
  // version again.
  const PinnedRoutes = ApiRoutes.pipe(
    Layer.provide(Layer.succeed(VersionedSchema.DefaultVersions, Customer.version(1)))
  )
  const pinnedUrl = yield* serve(PinnedRoutes)
  const pinned = yield* HttpApiClient.make(InstalledApi, { baseUrl: pinnedUrl })

  const read = yield* pinned.customers.get()
  yield* Effect.logInfo("Installed client reads, with the pin", read)

  const saved = yield* pinned.customers.save({ payload: { name: "Ada Lovelace" } })
  yield* Effect.logInfo("Installed client saves, with the pin", saved)

  // A client built with the versioned contract sends the header, so the pin
  // doesn't apply to it.
  const current = yield* HttpApiClient.make(Api, { baseUrl: pinnedUrl })

  const currentRead = yield* current.customers.get()
  yield* Effect.logInfo("Current client reads", currentRead)
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.scoped,
  Effect.timeout("30 seconds"),
  NodeRuntime.runMain
)
