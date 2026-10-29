import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { VersionedSchema } from "effect/schema"
import { Person } from "../src/Domain/Person.ts"
import { ada } from "../src/People/Seed.ts"

Effect.gen(function*() {
  // A record written before the name -> fullName migration.
  const record = {
    _version: 1,
    name: "Ada",
    status: "active",
    address: { _version: 1, street: "1 Main St" }
  }
  const person = yield* Schema.decodeUnknownEffect(Person)(record)
  yield* Effect.logInfo("Read an old record into the current Person", person)

  const current = yield* Schema.encodeEffect(Person)(ada)
  yield* Effect.logInfo("Write using the current schema versions", current)

  // While an old application still reads this storage, choose its versions.
  // Address has its own history, so select both schema ids explicitly.
  const compatible = VersionedSchema.at(Person, { Person: 1, Address: 1 })
  const old = yield* Schema.encodeEffect(compatible)(ada)
  yield* Effect.logInfo("Write for an older reader; email and city are dropped", old)

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
  yield* Effect.logInfo("Adopted an unversioned record", customer)
}).pipe(NodeRuntime.runMain)
