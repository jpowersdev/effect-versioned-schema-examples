import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import { Person } from "../src/Domain/Person.ts"
import * as Legacy from "../src/legacy.ts"

describe("Person", () => {
  it.effect("reads records the previous release wrote", () =>
    Effect.gen(function*() {
      const record = yield* Schema.encodeEffect(Legacy.Person)({ name: "Ada", status: "active" })
      assert.deepStrictEqual(record, { _version: 1, name: "Ada", status: "active" })
      assert.deepStrictEqual(yield* Schema.decodeUnknownEffect(Person)(record), { fullName: "Ada", status: "active" })
    }))

  it.effect("writes the latest version, or the versions it's given", () =>
    Effect.gen(function*() {
      const ada: Person = { fullName: "Ada", status: "active", email: "ada@example.com" }
      assert.deepStrictEqual(yield* Schema.encodeEffect(Person)(ada), { _version: 3, ...ada })
      assert.deepStrictEqual(yield* Schema.encodeEffect(VersionedSchema.at(Person, { Person: 2 }))(ada), {
        _version: 2,
        fullName: "Ada",
        status: "active"
      })
      const v1 = yield* Schema.encodeEffect(VersionedSchema.at(Person, { Person: 1 }))(ada)
      assert.deepStrictEqual(yield* Schema.decodeUnknownEffect(Legacy.Person)(v1), { name: "Ada", status: "active" })
    }))

  it("fails to write an archived person at v1", () => {
    const result = Schema.encodeResult(VersionedSchema.at(Person, { Person: 1 }))({
      fullName: "Grace",
      status: "archived"
    })
    assert.isTrue(Result.isFailure(result))
  })
})
