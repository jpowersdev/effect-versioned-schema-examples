import { Schema } from "effect"
import { VersionedSchema } from "effect/schema"

export const Address = VersionedSchema.make("Address", {
  version: 1,
  payload: Schema.Struct({ street: Schema.String })
})
