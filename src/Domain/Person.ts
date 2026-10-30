import { Schema } from "effect"
import { VersionedSchema } from "effect/schema"

// The application imports one Person; its complete history lives here.
export const Person = VersionedSchema.make("Person", {
  version: 1,
  payload: Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["active", "suspended"])
  })
}).next({
  version: 2,
  payload: Schema.Struct({
    fullName: Schema.String,
    status: Schema.Literals(["active", "suspended"])
  }),
  migration: (step) => step.renameField("name", "fullName")
}).next({
  version: 3,
  payload: Schema.Struct({
    fullName: Schema.String,
    status: Schema.Literals(["active", "suspended", "archived"]),
    email: Schema.optionalKey(Schema.String)
  }),
  migration: (step) =>
    step.addField("email").mapField("status", {
      up: (status) => status,
      down: (status) =>
        status === "archived"
          ? VersionedSchema.unrepresentable("An archived person needs Person v3")
          : status
    })
})

export type Person = typeof Person.Type

export class PersonNotFound extends Schema.TaggedError<PersonNotFound>()("PersonNotFound", {
  id: Schema.String
}) {}
