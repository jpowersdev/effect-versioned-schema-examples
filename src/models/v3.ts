import { Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import * as V2 from "./v2.ts"

export const Address = V2.Address

// Helpers compose, and next checks that they produce the new schema's type.
export const Person = V2.Person.next({
  version: 3,
  payload: Schema.Struct({
    fullName: Schema.String,
    status: Schema.Literals(["active", "suspended", "archived"]),
    email: Schema.optionalKey(Schema.String),
    address: Address
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

export const ada: typeof Person.Type = {
  fullName: "Ada",
  status: "active",
  email: "ada@example.com",
  address: { street: "1 Main St", city: "London" }
}

export const archived: typeof Person.Type = { ...ada, fullName: "Grace", status: "archived" }
