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
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"
import { PeopleV1, PeopleV3 } from "./entities.ts"

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

const demo = Effect.gen(function*() {
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
      console.log("Runner:", event.message)
    }
  })])

  const oldScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const oldRunner = yield* Layer.buildWithScope(
    PeopleV1.toLayer({
      Save: ({ payload }) =>
        Effect.sync(() => {
          handled.push(`v1:${payload.operation}`)
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
  console.log("Started a v1 runner.")

  // The sending client lives outside the runner scope, as a separate process
  // would. SQL polling carries requests and replies between their runtimes.
  const current = yield* PeopleV3.client.pipe(Effect.provideContext(clientContext))
  const old = yield* PeopleV1.client.pipe(Effect.provideContext(clientContext))
  const first = yield* current("ada").Save({ operation: "first", person: V3.ada }).pipe(
    Effect.forkChild({ startImmediately: true })
  )
  yield* waitUntil(Effect.sync(() => warnings.some((message) => message.includes("waits for a runner"))))
  assert.deepEqual(handled.slice(), [])

  const later = yield* old("ada").Save({ operation: "later", person: V1.ada }).pipe(
    Effect.forkChild({ startImmediately: true })
  )
  yield* waitUntil(
    Effect.map(
      sql<{ count: number }>`SELECT COUNT(*) AS count FROM cluster_messages WHERE kind = 0`,
      (rows) => rows[0].count === 2
    )
  )
  yield* old("bob").Save({ operation: "bob", person: V1.ada })
  assert.deepEqual(handled.slice(), ["v1:bob"])
  assert.equal(first.pollUnsafe(), undefined)
  assert.equal(later.pollUnsafe(), undefined)
  console.log("Person v3 is waiting; later work for Ada is held; Bob still progresses.")

  yield* Scope.close(oldScope, Exit.void)
  console.log("Stopped the v1 runner. The requests remain in SQLite.")

  const newScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  yield* Layer.buildWithScope(
    PeopleV3.toLayer({
      Save: ({ payload, versions }) =>
        Effect.sync(() => {
          handled.push(`v3:${payload.operation}`)
          console.log("v3 handler:", payload.operation, "reply versions:", versions)
          return payload.person
        })
    }).pipe(Layer.provideMerge(runtime(false)), Layer.provide(logger)),
    newScope
  ).pipe(
    Effect.provideContext(shared)
  )
  assert.deepEqual(yield* Fiber.join(first), V3.ada)
  assert.deepEqual(yield* Fiber.join(later), V1.ada)
  assert.deepEqual(handled.slice(), ["v1:bob", "v3:first", "v3:later"])
  console.log("Upgraded runner delivered both requests in order, with each caller's reply shape.")
  console.log("Cluster rollout example passed.")
})

await Effect.runPromise(demo.pipe(Effect.scoped, Effect.timeout("30 seconds")))
