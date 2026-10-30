import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { VersionedSchema } from "effect/schema"

// v1 stored `name`. v2 renamed it to `fullName` and added an optional `email`.
const Person = VersionedSchema.make("Person", {
  version: 1,
  payload: Schema.Struct({ name: Schema.String })
}).next({
  version: 2,
  payload: Schema.Struct({ fullName: Schema.String, email: Schema.optionalKey(Schema.String) }),
  migration: (step) => step.renameField("name", "fullName").addField("email")
})

type Person = typeof Person.Type

// Nested schemas have their own histories, even when the schema that contains
// them hasn't changed.
const Address = VersionedSchema.make("Address", {
  version: 1,
  payload: Schema.Struct({ street: Schema.String })
}).next({
  version: 2,
  payload: Schema.Struct({ street: Schema.String, city: Schema.optionalKey(Schema.String) }),
  migration: (step) => step.addField("city")
})

const Contact = Schema.Struct({ person: Person, address: Address })

Effect.gen(function*() {
  // A record the first release wrote reads as the current Person.
  const stored = { _version: 1, name: "Ada" }
  const person = yield* Schema.decodeUnknownEffect(Person)(stored)
  yield* Effect.logInfo("Read a stored v1 record", person)
  // => { fullName: "Ada" }

  const ada: Person = { ...person, email: "ada@example.com" }
  const latest = yield* Schema.encodeEffect(Person)(ada)
  yield* Effect.logInfo("Ordinary writes use the latest version", latest)
  // => { _version: 2, fullName: "Ada", email: "ada@example.com" }

  // While older readers share the data, write at a version they can read. The
  // fields that version lacks are dropped.
  const PersonForOlderReaders = VersionedSchema.at(Person, Person.version(1))
  const older = yield* Schema.encodeEffect(PersonForOlderReaders)(ada)
  yield* Effect.logInfo("Write for older readers", older)
  // => { _version: 1, name: "Ada" }

  // Pin each nested type an older reader needs.
  const ContactForOlderReaders = VersionedSchema.at(
    Contact,
    VersionedSchema.versions(Person.version(1), Address.version(1))
  )
  const contact = { person: ada, address: { street: "1 Main St", city: "London" } }
  const olderContact = yield* Schema.encodeEffect(ContactForOlderReaders)(contact)
  yield* Effect.logInfo("Write a contact for older readers", olderContact)
  // => { person: { _version: 1, name: "Ada" }, address: { _version: 1, street: "1 Main St" } }
}).pipe(
  NodeRuntime.runMain
)
