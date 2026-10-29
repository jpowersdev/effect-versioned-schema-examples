import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { Context, Effect, Exit, Fiber, Layer, Logger, Option, Scope } from "effect"
import {
  EntityId,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake,
  SqlMessageStorage
} from "effect/cluster"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { People } from "../src/People.ts"
import { ClusterPeopleLive } from "../src/People/Cluster.ts"
import { PersonEntity } from "../src/People/Entity.ts"
import { ada } from "../src/People/Seed.ts"
import { PersonEntity as LegacyPersonEntity } from "./fixtures/legacy/Entity.ts"
import { ada as legacyAda } from "./fixtures/legacy/Seed.ts"

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
  // Use the real entity handlers, observing their People dependency to assert
  // the order in which the persisted requests reach application code.
  const peopleContext = yield* Layer.build(People.layer)
  const people = Context.get(peopleContext, People)
  const observedPeople = Layer.succeed(
    People,
    People.of({
      ...people,
      save: Effect.fn(function*(id, person) {
        handled.push(`v3:${person.fullName}`)
        return yield* people.save(id, person)
      })
    })
  )
  yield* Layer.buildWithScope(
    ClusterPeopleLive.pipe(
      Layer.provide(observedPeople),
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

test("SQLite mailbox preserves order across an incompatible runner upgrade", () =>
  Effect.runPromise(rollout.pipe(Effect.scoped, Effect.timeout("30 seconds"))))
