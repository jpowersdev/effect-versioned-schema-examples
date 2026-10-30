import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import { Person } from "../src/Domain/Person.ts"

Effect.gen(function*() {
  // A record written by the first release reads as the current Person.
  const person = yield* Schema.decodeUnknownEffect(Person)({ _version: 1, name: "Ada", status: "active" })
  yield* Effect.logInfo("Read a stored v1 record", person)

  const ada: Person = { ...person, email: "ada@example.com" }
  yield* Effect.logInfo("Ordinary writes use the latest version", yield* Schema.encodeEffect(Person)(ada))

  // While older readers share the data, write at a version they can read. The
  // fields that version lacks are dropped.
  const forOlderReaders = VersionedSchema.at(Person, { Person: 1 })
  yield* Effect.logInfo("Write for older readers", yield* Schema.encodeEffect(forOlderReaders)(ada))

  // Nested schemas have their own histories. Pin each one an older reader
  // needs, even when the containing Contact schema hasn't changed.
  const Address = VersionedSchema.make("Address", {
    version: 1,
    payload: Schema.Struct({ street: Schema.String })
  }).next({
    version: 2,
    payload: Schema.Struct({ street: Schema.String, city: Schema.optionalKey(Schema.String) }),
    migration: (step) => step.addField("city")
  })
  const Contact = Schema.Struct({ person: Person, address: Address })
  const contact = { person: ada, address: { street: "1 Main St", city: "London" } }
  yield* Effect.logInfo(
    "Write a contact for older readers",
    yield* Schema.encodeEffect(VersionedSchema.at(Contact, { Person: 1, Address: 1 }))(contact)
  )
}).pipe(NodeRuntime.runMain)
