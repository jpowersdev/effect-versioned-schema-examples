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
  HttpApiGroup.make("customers")
    .add(HttpApiEndpoint.get("get", "/customer", { success: InstalledCustomer }))
    .add(HttpApiEndpoint.put("save", "/customer", { payload: InstalledCustomer, success: InstalledCustomer }))
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
  HttpApiGroup.make("customers")
    .add(HttpApiEndpoint.get("get", "/customer", { success: Customer }))
    .add(HttpApiEndpoint.put("save", "/customer", { payload: Customer, success: Customer }))
) {}

const HttpCustomersLive = HttpApiBuilder.group(
  Api,
  "customers",
  Effect.fn(function*(handlers) {
    // A record stored before versioning reads as v1, upgraded to the current shape.
    const customer = yield* Ref.make(yield* Schema.decodeUnknownEffect(Customer)({ name: "Ada" }))

    return handlers
      .handle("get", () => Ref.get(customer))
      .handle(
        "save",
        Effect.fn(function*({ payload }) {
          yield* Effect.logInfo("Server handler receives", payload)
          yield* Ref.set(customer, payload)
          return payload
        })
      )
  })
)

const ApiRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(HttpCustomersLive))

Effect.gen(function*() {
  // By default, requests without the header get the latest version, as servers
  // answer today. An installed client can't read v2.
  const unpinned = yield* HttpApiClient.make(InstalledApi, { baseUrl: yield* serve(ApiRoutes) })
  yield* unpinned.customers.get().pipe(
    Effect.flatMap((customer) => Effect.logInfo("Installed client reads", customer)),
    Effect.catch((error) => Effect.logWarning("Installed client can't read the latest version", error.message))
  )

  // Until every installed client sends the header, pin the version requests
  // without it get. Remove the pin afterwards, and they get the latest again.
  const baseUrl = yield* serve(
    ApiRoutes.pipe(Layer.provide(Layer.succeed(VersionedSchema.DefaultVersions, Customer.version(1))))
  )
  const installed = yield* HttpApiClient.make(InstalledApi, { baseUrl })
  yield* Effect.logInfo("Installed client reads, with the pin", yield* installed.customers.get())
  const saved = yield* installed.customers.save({ payload: { name: "Ada Lovelace" } })
  yield* Effect.logInfo("Installed client saves, with the pin", saved)

  // A client built with the versioned contract sends the header, so the pin
  // doesn't apply to it.
  const current = yield* HttpApiClient.make(Api, { baseUrl })
  yield* Effect.logInfo("Current client reads", yield* current.customers.get())
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.scoped,
  Effect.timeout("30 seconds"),
  NodeRuntime.runMain
)
