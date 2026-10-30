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
  // An explicit migration; step.renameField("name", "fullName") does the same.
  migration: (step) =>
    step.custom({
      up: ({ name, ...rest }) => ({ ...rest, fullName: name }),
      down: ({ fullName, ...rest }) => ({ ...rest, name: fullName })
    })
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
