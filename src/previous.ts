import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Ref, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { VersionedSchema } from "effect/schema"

// The previous release, frozen: the contract its clients still use, and the
// server some instances still run. Nothing here imports the current domain,
// because the previous release can't know about versions it never shipped.
export const Person = VersionedSchema.make("Person", {
  version: 1,
  payload: Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["active", "suspended"])
  })
})

export type Person = typeof Person.Type

export class PersonNotFound extends Schema.TaggedError<PersonNotFound>()("PersonNotFound", {
  id: Schema.String
}) {}

export class PeopleApiGroup extends HttpApiGroup.make("people").add(
  HttpApiEndpoint.get("getById", "/people/:id", {
    params: { id: Schema.String },
    success: Person,
    error: PersonNotFound.annotate({ httpApiStatus: 404 })
  }),
  HttpApiEndpoint.put("save", "/people/:id", {
    params: { id: Schema.String },
    payload: Person,
    success: Person
  })
) {}

export class Api extends HttpApi.make("api").add(PeopleApiGroup) {}

const PeopleApiHandlers = HttpApiBuilder.group(
  Api,
  "people",
  Effect.fn(function*(handlers) {
    const people = yield* Ref.make<ReadonlyMap<string, Person>>(
      new Map([["ada", { name: "Ada", status: "active" }]])
    )

    return handlers.handleAll({
      getById: Effect.fn(function*({ params }) {
        const person = (yield* Ref.get(people)).get(params.id)
        if (person === undefined) {
          return yield* new PersonNotFound({ id: params.id })
        }

        yield* Effect.logInfo("Old server returns", person)
        return person
      }),
      save: Effect.fn(function*({ params, payload }) {
        yield* Effect.logInfo("Old server handler receives", payload)
        yield* Ref.update(people, (current) => new Map(current).set(params.id, payload))
        return payload
      })
    })
  })
)

const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(PeopleApiHandlers)
)

// An HTTP server on a free port, with an HttpClient that sends requests to it.
// The server's own request logs are left out.
export const HttpServerLayer = HttpRouter.serve(ApiRoutes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest)
)
