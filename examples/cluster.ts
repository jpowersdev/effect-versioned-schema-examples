import { NodeRuntime } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Context, Effect, Exit, Fiber, Layer, Logger, Option, Scope } from "effect"
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
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Person } from "../src/Domain/Person.ts"
import { Person as LegacyPerson } from "../src/legacy.ts"

const PersonEntity = Entity.make("People", [
  Rpc.make("Save", { payload: { person: Person }, success: Person })
]).annotateRpcs(ClusterSchema.Persisted, true)
const LegacyPersonEntity = Entity.make("People", [
  Rpc.make("Save", { payload: { person: LegacyPerson }, success: LegacyPerson })
]).annotateRpcs(ClusterSchema.Persisted, true)
const ada: Person = { fullName: "Ada", status: "active", email: "ada@example.com" }
const legacyAda: LegacyPerson = { name: "Ada", status: "active" }

const config = {
  shardsPerGroup: 1,
  entityMessagePollInterval: 20,
  entityReplyPollInterval: 20,
  sendRetryInterval: 20,
  refreshAssignmentsInterval: 20,
  entityTerminationTimeout: 0
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>

const runtime = (clientOnly: boolean) =>
  Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provide(Snowflake.layerGenerator),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(ShardingConfig.layer({
      ...config,
      ...(clientOnly ? { runnerAddress: Option.none() } : {})
    }))
  )

const waitUntil = (condition: Effect.Effect<boolean, unknown>) =>
  Effect.gen(function*() {
    while (!(yield* condition)) yield* Effect.sleep(20)
  }).pipe(Effect.timeout("10 seconds"))

const rollout = Effect.gen(function*() {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "versioned-cluster-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
  )

  // The database and lock store outlive either runner. This uses a real SQLite
  // mailbox; no external database or Docker is needed for the walkthrough.
  const shared = yield* Layer.build(
    Layer.mergeAll(
      RunnerStorage.layerMemory,
      SqlMessageStorage.layer.pipe(Layer.provide(ShardingConfig.layer(config)))
    ).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: join(directory, "mailbox.sqlite") })),
      Layer.provide(NodeCrypto.layerDigest)
    )
  )
  const sql = Context.get(shared, SqlClient.SqlClient)
  const clientContext = yield* Layer.build(runtime(true)).pipe(Effect.provideContext(shared))
  const handled: Array<string> = []
  const warnings: Array<string> = []
  const logger = Logger.layer([Logger.make((event) => {
    if (event.logLevel === "Warn") {
      warnings.push(String(event.message))
    }
  })], { mergeWithExisting: true })

  const oldScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const oldRunner = yield* Layer.buildWithScope(
    LegacyPersonEntity.toLayer({
      Save: ({ payload }) =>
        Effect.sync(() => {
          handled.push(`v1:${payload.person.name}`)
          return payload.person
        })
    }).pipe(Layer.provideMerge(runtime(false)), Layer.provide(logger)),
    oldScope
  ).pipe(
    Effect.provideContext(shared)
  )
  const oldSharding = Context.get(oldRunner, Sharding.Sharding)
  const shard = oldSharding.getShardId(EntityId.make("ada"), "default")
  yield* waitUntil(Effect.sync(() => oldSharding.hasShardId(shard)))
  yield* Effect.logInfo("Started a v1 runner.")

  // The sending client lives outside the runner scope, as a separate process
  // would. SQL polling carries requests and replies between their runtimes.
  const current = yield* PersonEntity.client.pipe(Effect.provideContext(clientContext))
  const old = yield* LegacyPersonEntity.client.pipe(Effect.provideContext(clientContext))
  const first = yield* current("ada").Save({ person: ada }).pipe(
    Effect.forkChild({ startImmediately: true })
  )
  yield* waitUntil(Effect.sync(() => warnings.some((message) => message.includes("waits for a runner"))))
  assert.deepEqual(handled.slice(), [])

  const later = yield* old("ada").Save({ person: { ...legacyAda, name: "Ada Lovelace" } }).pipe(
    Effect.forkChild({ startImmediately: true })
  )
  yield* waitUntil(
    Effect.map(
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM cluster_messages WHERE kind = 0`,
      (rows) => rows[0].count === 2
    )
  )
  yield* old("bob").Save({ person: { ...legacyAda, name: "Bob" } })
  assert.deepEqual(handled.slice(), ["v1:Bob"])
  assert.equal(first.pollUnsafe(), undefined)
  assert.equal(later.pollUnsafe(), undefined)
  yield* Effect.logInfo("Person v3 is waiting; later work for Ada is held; Bob still progresses.")

  yield* Scope.close(oldScope, Exit.void)
  yield* Effect.logInfo("Stopped the v1 runner. The requests remain in SQLite.")

  const newScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const ClusterPeopleLive = PersonEntity.toLayer({
    Save: Effect.fn(function*({ payload, versions }) {
      handled.push(`v3:${payload.person.fullName}`)
      yield* Effect.logInfo("Upgraded runner handles the queued request", { person: payload.person, versions })
      return payload.person
    })
  })
  yield* Layer.buildWithScope(
    ClusterPeopleLive.pipe(
      Layer.provideMerge(runtime(false)),
      Layer.provide(logger)
    ),
    newScope
  ).pipe(Effect.provideContext(shared))
  assert.deepEqual(yield* Fiber.join(first), ada)
  assert.deepEqual(yield* Fiber.join(later), { ...legacyAda, name: "Ada Lovelace" })
  assert.deepEqual(handled.slice(), ["v1:Bob", "v3:Ada", "v3:Ada Lovelace"])
  yield* Effect.logInfo("Upgraded runner delivered both requests in order, with each caller's reply shape.")
  yield* Effect.logInfo("Cluster rollout example passed.")
})

rollout.pipe(Effect.scoped, Effect.timeout("30 seconds"), NodeRuntime.runMain)
