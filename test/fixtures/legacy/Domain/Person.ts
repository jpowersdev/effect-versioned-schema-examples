import { Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import { Address } from "./Address.ts"

// This is the schema an already-deployed application knows. It deliberately
// imports nothing from the current application, which would teach it v2/v3.
export const Person = VersionedSchema.make("Person", {
  version: 1,
  payload: Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["active", "suspended"]),
    address: Address
  })
})

export type Person = typeof Person.Type

export class PersonNotFound extends Schema.TaggedError<PersonNotFound>()("PersonNotFound", {
  id: Schema.String
}) {}
