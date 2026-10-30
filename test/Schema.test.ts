import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import { Person } from "../src/Domain/Person.ts"
import * as Legacy from "../src/legacy.ts"

const PersonAtV1 = VersionedSchema.at(Person, Person.version(1))
const PersonAtV2 = VersionedSchema.at(Person, Person.version(2))

describe("Person", () => {
  it.effect("reads records the previous release wrote", () =>
    Effect.gen(function*() {
      const record = yield* Schema.encodeEffect(Legacy.Person)({ name: "Ada", status: "active" })
      assert.deepStrictEqual(record, { _version: 1, name: "Ada", status: "active" })

      const person = yield* Schema.decodeUnknownEffect(Person)(record)
      assert.deepStrictEqual(person, { fullName: "Ada", status: "active" })
    }))

  it.effect("writes the latest version, or the versions it's given", () =>
    Effect.gen(function*() {
      const ada: Person = { fullName: "Ada", status: "active", email: "ada@example.com" }

      const latest = yield* Schema.encodeEffect(Person)(ada)
      assert.deepStrictEqual(latest, { _version: 3, ...ada })

      const v2 = yield* Schema.encodeEffect(PersonAtV2)(ada)
      assert.deepStrictEqual(v2, { _version: 2, fullName: "Ada", status: "active" })

      // The previous release reads what was written at v1
      const v1 = yield* Schema.encodeEffect(PersonAtV1)(ada)
      const legacy = yield* Schema.decodeUnknownEffect(Legacy.Person)(v1)
      assert.deepStrictEqual(legacy, { name: "Ada", status: "active" })
    }))

  it("fails to write an archived person at v1", () => {
    const result = Schema.encodeResult(PersonAtV1)({ fullName: "Grace", status: "archived" })
    assert.isTrue(Result.isFailure(result))
  })
})
