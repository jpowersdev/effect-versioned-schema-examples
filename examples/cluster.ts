import { NodeCrypto, NodeRuntime } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Effect, Exit, Fiber, Layer, Logger, Option, Schema, Scope } from "effect"
import {
  ClusterSchema,
  Entity,
  EntityId,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake,
  SqlMessageStorage
} from "effect/cluster"
import { Rpc } from "effect/rpc"
import { VersionedSchema } from "effect/schema"
import { SqlClient } from "effect/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PersonV1 = Schema.Struct({
  name: Schema.String
})

// The previous release only declared v1.
const PreviousPerson = VersionedSchema.make("Person", {
  version: 1,
  payload: PersonV1
})

// The current release renamed `name` and added an optional `email`.
const Person = VersionedSchema.make("Person", {
  version: 1,
  payload: PersonV1
}).next({
  version: 2,
  payload: Schema.Struct({
    fullName: Schema.String,
    email: Schema.optionalKey(Schema.String)
  }),
  migration: (step) => step.renameField("name", "fullName").addField("email")
})

type Person = typeof Person.Type

// The same persisted entity in two releases.
const PersonEntity = Entity.make("People", [
  Rpc.make("Save", {
    payload: {
      person: Person
    },
    success: Person
  })
]).annotateRpcs(ClusterSchema.Persisted, true)

const PreviousPersonEntity = Entity.make("People", [
  Rpc.make("Save", {
    payload: {
      person: PreviousPerson
    },
    success: PreviousPerson
  })
]).annotateRpcs(ClusterSchema.Persisted, true)

const PreviousPersonEntityLayer = PreviousPersonEntity.toLayer({
  Save: Effect.fn(function*({ payload }) {
    yield* Effect.logInfo("Old runner handles", payload.person)
    return payload.person
  })
})

const PersonEntityLayer = PersonEntity.toLayer({
  Save: Effect.fn(function*({ payload }) {
    // The Person version this caller sent. Its reply is written at the same
    // version.
    const version = yield* VersionedSchema.requestVersion(Person)
    yield* Effect.logInfo("Upgraded runner handles", {
      person: payload.person,
      version
    })
    return payload.person
  })
})

// One shard and short intervals, so the walkthrough finishes in seconds.
const shardingConfig = {
  shardsPerGroup: 1,
  entityMessagePollInterval: 20,
  entityReplyPollInterval: 20,
  sendRetryInterval: 20,
  refreshAssignmentsInterval: 20,
  entityTerminationTimeout: 0
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>

const shardingLayer = (options: {
  readonly runner: boolean
}) =>
  Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provide(Snowflake.layerGenerator),
    Layer.provide(RunnerHealth.layerNoop),
    // Without a runner address, sharding runs in client-only mode: it sends
    // messages but never owns a shard.
    Layer.provide(ShardingConfig.layer(
      options.runner ? shardingConfig : {
        ...shardingConfig,
        runnerAddress: Option.none()
      }
    ))
  )

// A row of the mailbox query in the walkthrough.
interface MessageRow {
  readonly entity_id: string
}

const waitUntil = (condition: Effect.Effect<boolean, unknown>) =>
  Effect.gen(function*() {
    while (!(yield* condition)) {
      yield* Effect.sleep(20)
    }
  }).pipe(
    Effect.timeout("10 seconds")
  )

Effect.gen(function*() {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "versioned-cluster-"))),
    (path) =>
      Effect.promise(() =>
        rm(path, {
          recursive: true,
          force: true
        })
      )
  )

  // The SQLite mailbox and the runner locks outlive either runner, as a shared
  // database would.
  const StorageLayer = Layer.mergeAll(
    RunnerStorage.layerMemory,
    SqlMessageStorage.layer.pipe(Layer.provide(ShardingConfig.layer(shardingConfig)))
  ).pipe(
    Layer.provideMerge(SqliteClient.layer({
      filename: join(directory, "mailbox.sqlite")
    })),
    Layer.provide(NodeCrypto.layerDigest)
  )
  const storage = yield* Layer.build(StorageLayer)

  // The people whose requests are still waiting in the mailbox, in order.
  // `kind = 0` selects requests.
  const sql = Context.get(storage, SqlClient.SqlClient)
  const waitingPeople = sql<MessageRow>`
    SELECT entity_id FROM cluster_messages
    WHERE kind = 0 AND processed = 0
    ORDER BY id
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.entity_id))
  )

  // A runner logs a warning when it leaves a message it can't read for an
  // upgraded runner. The walkthrough waits for that warning.
  const warnings: Array<string> = []
  const WarningsLoggerLayer = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message))
    })
  ], {
    mergeWithExisting: true
  })

  // Starts a runner in its own scope, so the walkthrough can stop it partway
  // through, and waits until it owns Ada's shard.
  const startRunner = <E>(entityLayer: Layer.Layer<never, E, Sharding.Sharding>) =>
    Effect.gen(function*() {
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const RunnerLayer = entityLayer.pipe(
        Layer.provideMerge(shardingLayer({
          runner: true
        })),
        Layer.provide(WarningsLoggerLayer)
      )
      const runner = yield* Layer.buildWithScope(RunnerLayer, scope).pipe(
        Effect.provideContext(storage)
      )

      const sharding = Context.get(runner, Sharding.Sharding)
      const shard = sharding.getShardId(EntityId.make("ada"), "default")
      yield* waitUntil(Effect.sync(() => sharding.hasShardId(shard)))

      return scope
    })

  // Callers live outside the runners, as another process would.
  const callers = yield* Layer.build(shardingLayer({
    runner: false
  })).pipe(
    Effect.provideContext(storage)
  )
  const upgraded = yield* PersonEntity.client.pipe(Effect.provideContext(callers))
  const old = yield* PreviousPersonEntity.client.pipe(Effect.provideContext(callers))

  const oldRunner = yield* startRunner(PreviousPersonEntityLayer)
  yield* Effect.logInfo("Started a runner from the old release")

  // An upgraded caller sends Person v2, which the old runner can't read. The
  // message stays in the mailbox until an upgraded runner owns Ada's shard.
  const ada: Person = {
    fullName: "Ada",
    email: "ada@example.com"
  }
  const upgradedSave = yield* upgraded("ada").Save({
    person: ada
  }).pipe(
    Effect.forkChild({
      startImmediately: true
    })
  )
  yield* waitUntil(Effect.sync(() => warnings.some((message) => message.includes("waits for a runner"))))
  // => A persisted message waits for a runner that can read Person v2 (this runner reads up to v1)

  // An old caller's save for Ada is v1, which the old runner could read, but it
  // waits behind the v2 message so Ada's requests stay in order.
  const oldSave = yield* old("ada").Save({
    person: {
      name: "Ada Lovelace"
    }
  }).pipe(
    Effect.forkChild({
      startImmediately: true
    })
  )
  yield* waitUntil(Effect.map(waitingPeople, (people) => people.length === 2))

  // Bob has nothing waiting ahead of him, so the old runner handles his save.
  yield* old("bob").Save({
    person: {
      name: "Bob"
    }
  })
  // => Old runner handles { name: "Bob" }

  const waiting = yield* waitingPeople
  yield* Effect.logInfo("Waiting in SQLite", waiting)
  // => ["ada", "ada"]

  yield* Scope.close(oldRunner, Exit.void)
  yield* Effect.logInfo("Replacing the old runner with an upgraded one")
  yield* startRunner(PersonEntityLayer)
  // => Upgraded runner handles { person: { fullName: "Ada", email: "ada@example.com" }, version: 2 }
  // => Upgraded runner handles { person: { fullName: "Ada Lovelace" }, version: 1 }

  // Each caller gets its reply at the version it sent.
  const upgradedReply = yield* Fiber.join(upgradedSave)
  yield* Effect.logInfo("Upgraded caller receives", upgradedReply)
  // => { fullName: "Ada", email: "ada@example.com" }

  const oldReply = yield* Fiber.join(oldSave)
  yield* Effect.logInfo("Old caller receives", oldReply)
  // => { name: "Ada Lovelace" }
}).pipe(
  Effect.scoped,
  Effect.timeout("30 seconds"),
  NodeRuntime.runMain
)
