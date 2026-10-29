import { Schema } from "effect"
import { VersionedSchema } from "effect/schema"

export const Address = VersionedSchema.make("Address", {
  version: 1,
  payload: Schema.Struct({ street: Schema.String })
})

export const Person = VersionedSchema.make("Person", {
  version: 1,
  payload: Schema.Struct({
    name: Schema.String,
    status: Schema.Literals(["active", "suspended"]),
    address: Address
  })
})

export const ada: typeof Person.Type = {
  name: "Ada",
  status: "active",
  address: { street: "1 Main St" }
}
