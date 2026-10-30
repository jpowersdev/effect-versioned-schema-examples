import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { VersionedSchema } from "effect/schema"

// Frozen contracts shipped by the old application. No imports from the current
// domain: an old client cannot know about versions that have not shipped yet.
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
