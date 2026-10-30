import { Effect, Schema } from "effect"

// The Person the endpoints use when they don't use versioning.
export const Person = Schema.Struct({
  fullName: Schema.String,
  status: Schema.Literals(["active", "suspended", "archived"]),
  email: Schema.optionalKey(Schema.String)
})

export type Person = typeof Person.Type

export const ada: Person = {
  fullName: "Ada Lovelace",
  status: "active",
  email: "ada@example.com"
}

// Without versions, every client speaks the only shape.
export const speaking = (_version: "latest" | "v1") => <A, E, R>(effect: Effect.Effect<A, E, R>) => effect

export const received = (_version: "latest" | "v1"): Person => ada
