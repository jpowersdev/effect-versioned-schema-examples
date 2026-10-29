import { Effect, Result, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Person } from "../src/Domain/Person.ts"
import { ada, grace } from "../src/People/Seed.ts"
import { Person as LegacyPerson } from "./fixtures/legacy/Domain/Person.ts"
import { ada as legacyAda } from "./fixtures/legacy/Seed.ts"

test("old records decode to the current Person; writes select versions explicitly", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const oldRecord = yield* Schema.encodeEffect(LegacyPerson)(legacyAda)
      const upgraded = yield* Schema.decodeUnknownEffect(Person)(oldRecord)
      assert.deepEqual(upgraded, { fullName: "Ada", status: "active", address: { street: "1 Main St" } })
      assert.equal("_version" in upgraded, false)

      const currentRecord = yield* Schema.encodeEffect(Person)(ada)
      assert.equal(currentRecord._version, 3)
      assert.equal(currentRecord.address._version, 2)

      const compatible = VersionedSchema.at(Person, { Person: 1, Address: 1 })
      const olderWrite = yield* Schema.encodeEffect(compatible)(ada)
      assert.deepEqual(olderWrite, oldRecord)
      assert.deepEqual(yield* Schema.decodeUnknownEffect(LegacyPerson)(olderWrite), legacyAda)

      const middleWrite = yield* Schema.encodeEffect(VersionedSchema.at(Person, { Person: 2, Address: 2 }))(ada)
      assert.deepEqual(middleWrite, {
        _version: 2,
        fullName: "Ada",
        status: "active",
        address: { _version: 2, street: "1 Main St", city: "London" }
      })

      // Nested schema ids are independent; selecting Person does not pin Address.
      const nested = yield* Schema.encodeEffect(VersionedSchema.at(Person, { Person: 1 }))(ada)
      assert.equal(nested._version, 1)
      assert.equal(nested.address._version, 2)

      // Schema encoders fail with SchemaError; transports expose Unrepresentable.
      const rejected = Schema.encodeResult(compatible)(grace)
      assert.ok(Result.isFailure(rejected))
      assert.equal(rejected.failure._tag, "SchemaError")
      yield* Effect.logInfo("Storage reads, explicit writes, and unrepresentable values checked")
    })
  ))

test("unversioned records can be adopted as the first version", () => {
  const Customer = VersionedSchema.make("Customer", {
    version: 1,
    payload: Schema.Struct({ name: Schema.String }),
    unversioned: true
  }).next({
    version: 2,
    payload: Schema.Struct({ fullName: Schema.String }),
    migration: (step) => step.renameField("name", "fullName")
  })
  assert.deepEqual(Schema.decodeUnknownSync(Customer)({ name: "Ada" }), { fullName: "Ada" })
})
