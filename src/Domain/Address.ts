import { Schema } from "effect"
import { VersionedSchema } from "effect/schema"

export const Address = VersionedSchema.make("Address", {
  version: 1,
  payload: Schema.Struct({ street: Schema.String })
}).next({
  version: 2,
  payload: Schema.Struct({ street: Schema.String, city: Schema.optionalKey(Schema.String) }),
  migration: (step) => step.addField("city")
})

export type Address = typeof Address.Type
