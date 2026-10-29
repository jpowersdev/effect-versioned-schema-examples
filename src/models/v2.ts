import { Schema } from "effect"
import * as V1 from "./v1.ts"

export const Address = V1.Address.next({
  version: 2,
  payload: Schema.Struct({ street: Schema.String, city: Schema.optionalKey(Schema.String) }),
  migration: (step) => step.addField("city")
})

// An explicit migration. The equivalent helper is renameField("name", "fullName").
export const Person = V1.Person.next({
  version: 2,
  payload: Schema.Struct({
    fullName: Schema.String,
    status: Schema.Literals(["active", "suspended"]),
    address: Address
  }),
  migration: (step) =>
    step.custom({
      up: ({ name, ...rest }) => ({ ...rest, fullName: name }),
      down: ({ fullName, ...rest }) => ({ ...rest, name: fullName })
    })
})
