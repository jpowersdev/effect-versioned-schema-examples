import { Effect, Layer, Ref, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { VersionedSchema } from "effect/schema"

// The previous release, frozen: the contract its installed clients still use,
// and the server some instances still run. Nothing here imports the current
// domain, because the old release cannot know about versions it never shipped.
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

export class Api extends HttpApi.make("api").add(
  HttpApiGroup.make("people")
    .add(HttpApiEndpoint.get("getById", "/people/:id", {
      params: { id: Schema.String },
      success: Person,
      error: PersonNotFound.annotate({ httpApiStatus: 404 })
    }))
    .add(HttpApiEndpoint.put("save", "/people/:id", {
      params: { id: Schema.String },
      payload: Person,
      success: Person
    }))
) {}

const HttpPeopleLive = HttpApiBuilder.group(
  Api,
  "people",
  Effect.fn(function*(handlers) {
    const people = yield* Ref.make<ReadonlyMap<string, Person>>(
      new Map([["ada", { name: "Ada", status: "active" }]])
    )

    return handlers
      .handle(
        "getById",
        Effect.fn(function*({ params }) {
          const person = (yield* Ref.get(people)).get(params.id)
          if (person === undefined) return yield* new PersonNotFound({ id: params.id })
          yield* Effect.logInfo("Old server returns", person)
          return person
        })
      )
      .handle(
        "save",
        Effect.fn(function*({ params, payload }) {
          yield* Effect.logInfo("Old server handler receives", payload)
          yield* Ref.update(people, (current) => new Map(current).set(params.id, payload))
          return payload
        })
      )
  })
)

export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(HttpPeopleLive))
