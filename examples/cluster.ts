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
import { VersionedSchema } from "effect/schema"
import { SqlClient } from "effect/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Person } from "../src/Domain/Person.ts"
import * as Legacy from "../src/legacy.ts"

// The same persisted entity in two releases.
const PersonEntity = Entity.make("People", [
  Rpc.make("Save", { payload: { person: Person }, success: Person })
]).annotateRpcs(ClusterSchema.Persisted, true)
const LegacyPersonEntity = Entity.make("People", [
  Rpc.make("Save", { payload: { person: Legacy.Person }, success: Legacy.Person })
]).annotateRpcs(ClusterSchema.Persisted, true)

const LegacyPeopleLive = LegacyPersonEntity.toLayer({
  Save: Effect.fn(function*({ payload }) {
    yield* Effect.logInfo("Old runner handles", payload.person)
    return payload.person
  })
})
const ClusterPeopleLive = PersonEntity.toLayer({
  Save: Effect.fn(function*({ payload }) {
    const versions = yield* VersionedSchema.RequestVersions
    yield* Effect.logInfo("Upgraded runner handles", { person: payload.person, versions })
    return payload.person
  })
})

// Short intervals so the walkthrough finishes in seconds.
const config = {
  shardsPerGroup: 1,
  entityMessagePollInterval: 20,
  entityReplyPollInterval: 20,
  sendRetryInterval: 20,
  refreshAssignmentsInterval: 20,
  entityTerminationTimeout: 0
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>

const ShardingLive = (options: { readonly runner: boolean }) =>
  Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provide(Snowflake.layerGenerator),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(ShardingConfig.layer(options.runner ? config : { ...config, runnerAddress: Option.none() }))
  )

const waitUntil = (condition: Effect.Effect<boolean, unknown>) =>
  Effect.gen(function*() {
    while (!(yield* condition)) yield* Effect.sleep(20)
  }).pipe(Effect.timeout("10 seconds"))

Effect.gen(function*() {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "versioned-cluster-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
  )

  // The SQLite mailbox and the runner locks outlive either runner, as a shared
  // database would.
  const storage = yield* Layer.build(
    Layer.mergeAll(
      RunnerStorage.layerMemory,
      SqlMessageStorage.layer.pipe(Layer.provide(ShardingConfig.layer(config)))
    ).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: join(directory, "mailbox.sqlite") })),
      Layer.provide(NodeCrypto.layerDigest)
    )
  )
  const sql = Context.get(storage, SqlClient.SqlClient)
  const waiting = sql<{ entity_id: string }>`
    SELECT entity_id FROM cluster_messages WHERE kind = 0 AND processed = 0 ORDER BY id`.pipe(
    Effect.map((rows) => rows.map((row) => row.entity_id))
  )

  // The runners' warnings show when a message waits for an upgraded runner.
  const warnings: Array<string> = []
  const WarningsLive = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message))
    })
  ], { mergeWithExisting: true })

  const startRunner = <E>(entity: Layer.Layer<never, E, Sharding.Sharding>) =>
    Effect.gen(function*() {
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const runner = yield* Layer.buildWithScope(
        entity.pipe(Layer.provideMerge(ShardingLive({ runner: true })), Layer.provide(WarningsLive)),
        scope
      ).pipe(Effect.provideContext(storage))
      const sharding = Context.get(runner, Sharding.Sharding)
      const shard = sharding.getShardId(EntityId.make("ada"), "default")
      yield* waitUntil(Effect.sync(() => sharding.hasShardId(shard)))
      return scope
    })

  // Callers live outside the runners, as another process would.
  const callers = yield* Layer.build(ShardingLive({ runner: false })).pipe(Effect.provideContext(storage))
  const current = yield* PersonEntity.client.pipe(Effect.provideContext(callers))
  const old = yield* LegacyPersonEntity.client.pipe(Effect.provideContext(callers))

  const oldRunner = yield* startRunner(LegacyPeopleLive)
  yield* Effect.logInfo("Started a runner from the old release")

  // An upgraded caller sends Person v3 before any runner can read it.
  const first = yield* current("ada").Save({ person: { fullName: "Ada", status: "active", email: "ada@example.com" } })
    .pipe(Effect.forkChild({ startImmediately: true }))
  yield* waitUntil(Effect.sync(() => warnings.some((message) => message.includes("waits for a runner"))))

  // Later work for Ada waits behind it, in order. Other people still progress.
  const later = yield* old("ada").Save({ person: { name: "Ada Lovelace", status: "active" } })
    .pipe(Effect.forkChild({ startImmediately: true }))
  yield* waitUntil(Effect.map(waiting, (ids) => ids.length === 2))
  yield* old("bob").Save({ person: { name: "Bob", status: "active" } })
  yield* Effect.logInfo("Waiting in SQLite", yield* waiting)

  yield* Scope.close(oldRunner, Exit.void)
  yield* Effect.logInfo("Replaced the old runner with an upgraded one")
  yield* startRunner(ClusterPeopleLive)

  // Each caller gets its reply at the version it sent.
  yield* Effect.logInfo("Upgraded caller receives", yield* Fiber.join(first))
  yield* Effect.logInfo("Old caller receives", yield* Fiber.join(later))
}).pipe(Effect.scoped, Effect.timeout("30 seconds"), NodeRuntime.runMain)
