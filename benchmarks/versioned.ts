import { Effect, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import { ada, Person as LatestPerson } from "./plain.ts"

export { ada }

// The same Person with two older versions, as in the examples.
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
  payload: LatestPerson,
  migration: (step) =>
    step.addField("email").mapField("status", {
      up: (status) => status,
      down: (status) =>
        status === "archived"
          ? VersionedSchema.unrepresentable("An archived person needs Person v3")
          : status
    })
})

// A v1 client is a current client that speaks Person v1.
export const speaking = (version: "latest" | "v1") => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  version === "v1" ? effect.pipe(Effect.provideService(VersionedSchema.ClientVersions, Person.version(1))) : effect

// What the client decodes. At v1, `email` doesn't survive the trip.
export const received = (version: "latest" | "v1"): typeof Person.Type =>
  version === "v1"
    ? {
      fullName: ada.fullName,
      status: ada.status
    }
    : ada
