import { Effect, Result, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import assert from "node:assert/strict"
import * as V1 from "./models/v1.ts"
import * as V2 from "./models/v2.ts"
import * as V3 from "./models/v3.ts"

const oldRecord = Schema.encodeSync(V1.Person)(V1.ada)
const upgraded = Schema.decodeUnknownSync(V3.Person)(oldRecord)
assert.deepEqual(upgraded, { fullName: "Ada", status: "active", address: { street: "1 Main St" } })
assert.equal("_version" in upgraded, false)
console.log("Stored v1 record:", oldRecord)
console.log("Read by v3:", upgraded)

const currentRecord = Schema.encodeSync(V3.Person)(V3.ada)
assert.equal(currentRecord._version, 3)
console.log("Ordinary storage write uses this build's latest version:", currentRecord)

// Pin both ids while an older application still reads the same storage.
const compatible = VersionedSchema.at(V3.Person, { Person: 1, Address: 1 })
const olderWrite = Schema.encodeSync(compatible)(V3.ada)
assert.deepEqual(Schema.decodeUnknownSync(V1.Person)(olderWrite), V1.ada)
console.log("Explicit v1 write (email and city are dropped):", olderWrite)

const middleWrite = Schema.encodeSync(VersionedSchema.at(V3.Person, { Person: 2, Address: 2 }))(V3.ada)
assert.deepEqual(Schema.decodeUnknownSync(V2.Person)(middleWrite), {
  fullName: "Ada",
  status: "active",
  address: { street: "1 Main St", city: "London" }
})
console.log("Explicit v2 write:", middleWrite)

// Schema encoding fails with SchemaError. Transports turn this incompatibility
// into a typed Unrepresentable response; the following demos show that boundary.
const rejected = Schema.encodeResult(compatible)(V3.archived)
assert.ok(Result.isFailure(rejected))
console.log("An archived person cannot be written at v1:", rejected.failure.message)

// Adopting existing records is an explicit choice for the first version only.
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
console.log("Adopted an existing unversioned record:", Schema.decodeUnknownSync(Customer)({ name: "Ada" }))

// The API permits only known schema ids and versions here.
const typedWrite = Schema.encodeEffect(VersionedSchema.at(V3.Person, { Person: 1, Address: 1 }))(V3.ada)
assert.deepEqual(await Effect.runPromise(typedWrite), oldRecord)
console.log("Schema examples passed.")
