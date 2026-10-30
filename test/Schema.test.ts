import { Effect, Result, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Person } from "../src/Domain/Person.ts"
import { Person as LegacyPerson } from "../src/legacy.ts"

test("one Person history reads old records and writes selected versions", () =>
  Effect.runPromise(
    Effect.gen(function*() {
      const legacy = { name: "Ada", status: "active" as const }
      const ada = { fullName: "Ada", status: "active" as const, email: "ada@example.com" }
      const record = yield* Schema.encodeEffect(LegacyPerson)(legacy)
      const decoded = yield* Schema.decodeUnknownEffect(Person)(record)
      assert.deepEqual(decoded, { fullName: "Ada", status: "active" })
      assert.equal("_version" in decoded, false)
      assert.deepEqual(yield* Schema.encodeEffect(Person)(ada), { _version: 3, ...ada })
      assert.deepEqual(yield* Schema.encodeEffect(VersionedSchema.at(Person, { Person: 2 }))(ada), {
        _version: 2,
        fullName: "Ada",
        status: "active"
      })
      const compatible = VersionedSchema.at(Person, { Person: 1 })
      const old = yield* Schema.encodeEffect(compatible)(ada)
      assert.deepEqual(old, record)
      assert.deepEqual(yield* Schema.decodeUnknownEffect(LegacyPerson)(old), legacy)
      const rejected = Schema.encodeResult(compatible)({ fullName: "Grace", status: "archived" })
      assert.ok(Result.isFailure(rejected))
      assert.equal(rejected.failure._tag, "SchemaError")
    })
  ))
