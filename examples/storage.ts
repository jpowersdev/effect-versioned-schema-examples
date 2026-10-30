import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import { Person } from "../src/Domain/Person.ts"

Effect.gen(function*() {
  const record = { _version: 1, name: "Ada", status: "active" }
  const person = yield* Schema.decodeUnknownEffect(Person)(record)
  assert.deepEqual(person, { fullName: "Ada", status: "active" })
  yield* Effect.logInfo("Read an old stored record into the current Person", person)

  const current = yield* Schema.encodeEffect(Person)({ ...person, email: "ada@example.com" })
  assert.equal(current._version, 3)
  yield* Effect.logInfo("Ordinary writes use this build's latest version", current)

  const compatible = VersionedSchema.at(Person, { Person: 1 })
  const old = yield* Schema.encodeEffect(compatible)({ ...person, email: "ada@example.com" })
  assert.deepEqual(old, record)
  yield* Effect.logInfo("Write for an older reader; email is dropped", old)

  // Nested schemas can evolve independently. Pin each id that an older reader
  // needs, even when the containing Contact schema has not changed at all.
  const Address = VersionedSchema.make("Address", {
    version: 1,
    payload: Schema.Struct({ street: Schema.String })
  }).next({
    version: 2,
    payload: Schema.Struct({ street: Schema.String, city: Schema.optionalKey(Schema.String) }),
    migration: (step) => step.addField("city")
  })
  const Contact = Schema.Struct({ person: Person, address: Address })
  const contact = { person, address: { street: "1 Main St", city: "London" } }
  const nested = yield* Schema.encodeEffect(VersionedSchema.at(Contact, { Person: 1, Address: 1 }))(contact)
  assert.deepEqual(nested, { person: record, address: { _version: 1, street: "1 Main St" } })
  yield* Effect.logInfo("Choose versions for independently evolving nested schemas", nested)

  // Existing unmarked records can be adopted as the first version.
  const Customer = VersionedSchema.make("Customer", {
    version: 1,
    payload: Schema.Struct({ name: Schema.String }),
    unversioned: true
  }).next({
    version: 2,
    payload: Schema.Struct({ fullName: Schema.String }),
    migration: (step) => step.renameField("name", "fullName")
  })
  const customer = yield* Schema.decodeUnknownEffect(Customer)({ name: "Ada" })
  assert.deepEqual(customer, { fullName: "Ada" })
  yield* Effect.logInfo("Adopted an unversioned record", customer)
}).pipe(NodeRuntime.runMain)
