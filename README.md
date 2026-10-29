# Versioned schemas for Effect

A small People application demonstrating the [versioned-schema proposal](https://github.com/jpowersdev/effect/tree/feat/versioned-schema-v2): one domain schema with its migration history, a service, HTTP and RPC handlers, and a typed client.

The layout follows [tim-smart/effect-http-play](https://github.com/tim-smart/effect-http-play), using this proposal's v4 APIs. Packages are pinned to [`ee7ab8096f`](https://github.com/jpowersdev/effect/commit/ee7ab8096ffe96ef15bb46a33b41899afc66e0b7), an unreleased proposal build. They are installed from this repository's [development package release](https://github.com/jpowersdev/effect-versioned-schema-examples/releases/tag/snapshot-ee7ab8096f).

## Run the application

Use Node **24.21.0** and pnpm **11.20.0** (recorded in `.node-version` and `package.json`). No Docker or external database is required.

```sh
git clone https://github.com/jpowersdev/effect-versioned-schema-examples.git
cd effect-versioned-schema-examples
pnpm install --frozen-lockfile
pnpm start
```

In another terminal:

```sh
pnpm client
```

The server listens at `http://127.0.0.1:3000`, serves the HTTP API and `/rpc`, and exposes `/openapi.json`. The client reads Ada, updates her email, and logs the result with `Effect.logInfo`. Both entry points use `NodeRuntime.runMain`; interrupting the server closes its resources.

Use `PORT=3001 pnpm start` and `API_URL=http://127.0.0.1:3001 pnpm client` to change the address. `pnpm dev` restarts the server on source changes.

The `People` service uses an in-memory store seeded with Ada and Grace. HTTP and RPC share that store. `PUT /people/:id` replaces the whole person, so writing an older shape can discard fields it does not contain. Restarting the server resets the sample data.

## Layout

```text
src/
  Domain/
    Address.ts           Address and its migration history
    Person.ts            Person and its migration history; PersonNotFound
  People.ts              Application service and in-memory implementation
  People/
    Api.ts               HTTP endpoint contracts
    Http.ts              HTTP handlers using People
    Rpcs.ts              RPC contracts
    Rpc.ts               RPC handlers using People
    Entity.ts            Persisted cluster entity contract
    Cluster.ts           Entity handlers using People
    Seed.ts              Sample application data
  Api.ts                 Combined HTTP API
  Http.ts                HTTP and RPC routes, layer composition, server
  main.ts                Server entry point
  client.ts              Typed HTTP client entry point
examples/
  storage.ts             Reading old records and choosing write versions
test/
  Schema.test.ts         Storage compatibility
  Http.test.ts           Old and new clients/servers over real HTTP
  Rpc.test.ts            RPC compatibility and partial stream delivery
  Cluster.test.ts        SQLite mailbox during a runner upgrade
  fixtures/legacy/       Frozen contracts from the older application
  helpers/serve.ts        Scoped listeners on OS-selected ports
```

## One Person schema

Application code imports `Person` from [Domain/Person.ts](src/Domain/Person.ts). That module defines the complete history in one `VersionedSchema.make(...).next(...).next(...)` chain:

1. `name`, `status`, and `address`.
2. Rename `name` to `fullName` with an explicit `custom` migration. The equivalent helper is `step.renameField("name", "fullName")`.
3. Add optional `email` with `addField` and extend `status` with `mapField`. An `archived` person cannot be downgraded, so the reverse mapping returns `VersionedSchema.unrepresentable(...)`.

[Address](src/Domain/Address.ts) owns its own history: version 2 adds optional `city`. Each Person payload refers to that domain schema; nested histories evolve independently.

The [HTTP contract](src/People/Api.ts) and [RPC contract](src/People/Rpcs.ts) use `Person` directly. The [handlers](src/People/Http.ts) work with its current decoded type. There is no version namespace in application code and no generic API factory taking a different Person for each deployment.

```ts
import { Person } from "./Domain/Person.ts"

const record = yield* Schema.decodeUnknownEffect(Person)(storedJson)
// record.fullName is available even when storedJson was written at v1.

const encoded = yield* Schema.encodeEffect(Person)(record)
// A normal write uses the latest versions declared by this build.
```

Decoded values are plain application objects. Encoded records carry `_version`. To write for older storage readers, choose the target versions explicitly:

```ts
const compatible = VersionedSchema.at(Person, { Person: 1, Address: 1 })
const encoded = yield * Schema.encodeEffect(compatible)(person)
```

Selecting an older Person does not implicitly select an older nested Address. Older writes can deliberately lose fields such as `email` and `city`.

Run `pnpm example:storage` for [the runnable storage example](examples/storage.ts), including adoption of existing unmarked records using `unversioned: true`. Deploy that reader before introducing newer marked records; applications built before adoption do not gain compatibility retroactively.

## Client/server compatibility

Run all checks with `pnpm test`, or select a walkthrough:

| Command             | What it checks                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm test:schema`  | Old records, explicit v1/v2 writes, independent nested versions, unrepresentable values, unversioned adoption |
| `pnpm test:http`    | Both directions of version skew, persisted application updates, explicit retry, actual JSON markers           |
| `pnpm test:rpc`     | Both directions of version skew, shared HTTP/RPC state, explicit retry, partial stream failure                |
| `pnpm test:cluster` | SQLite mailbox waiting for an upgraded runner and preserving per-entity order                                 |

These are executable compatibility walkthroughs with assertions and Effect logging. They use Node's test runner; `Effect.runPromise` is confined to that runner boundary. The server/client application remains in `src/`.

The [legacy fixtures](test/fixtures/legacy) represent an application already deployed with Person v1 and Address v1. They import nothing from the current application. A current schema configured to _write_ v1 still decodes to the current type, so it would not faithfully model an old client. Keeping a frozen old contract lets the tests check that distinction without making historical builds part of the application's structure.

Both builds run in one test process, with separate schema objects and actual loopback HTTP connections on OS-selected ports. The current servers use the application's real routes and service layers.

| Client → server                      | Result                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| Current → current                    | Current request and response shapes                                   |
| Old → current                        | Old payloads upgrade on the server; replies encode for the old client |
| Current → old, response-only read    | The server returns a version it knows; the newer client upgrades it   |
| Current → old, newer request payload | `VersionUnsupported` before the handler runs                          |
| Explicit retry at `error.supported`  | Compatible values downgrade and the request succeeds                  |
| Archived person → old client         | `Unrepresentable`, because the old status type cannot hold the value  |

The retry is application policy, expressed once at the call site:

```ts
save.pipe(
  Effect.catchTag(
    "VersionUnsupported",
    (error) => save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))
  )
)
```

An `Unrepresentable` response can occur **after** a handler has run. Its side effects are not rolled back; the examples do not retry that failure. Direct schema encoders return `SchemaError`; the transport integrations expose typed compatibility errors.

The RPC stream delivers Ada, then fails at Grace's archived status. The HTTP walkthrough also inspects the raw response to show the markers absent from decoded application values.

## Cluster rollout

The [entity contract](src/People/Entity.ts) marks `Save` as persisted, and the [entity handlers](src/People/Cluster.ts) call the same `People` service. The [rollout test](test/Cluster.test.ts) supplies the cluster infrastructure and a temporary file-backed SQLite mailbox:

1. Start an old runner and send a current request for Ada.
2. Observe that request waiting for a compatible runner.
3. Queue an older, readable update for Ada behind it. Bob's request still runs.
4. Stop the old runner while keeping the database and sending client alive.
5. Start the current runner with the application's entity handlers. Both Ada requests run in order and receive replies at their callers' versions.

The test verifies that no Ada handler ran before the upgrade. It does not translate or discard the queued request. `unknownVersionTimeout` stays at its default, infinity; the walkthrough itself has a timeout so failures cannot leave it hanging.

This is a single-process rollout with SQL polling and an in-memory runner lock store. It demonstrates mailbox persistence across runner replacement, not multi-host coordination or process-crash recovery. The temporary database is removed afterward. Workflow activity and durable-deferred replay are outside this proposal's cluster integration.

## The package pin

[snapshot.json](snapshot.json) records the full source commit, package versions, build tool versions, and SHA-256 checksums. All four Effect packages come from that commit. `pnpm-workspace.yaml` overrides transitive Effect dependencies to the same artifacts, and the committed lockfile records their integrity hashes. The workspace explicitly permits the transitive tarball URLs required by these overrides.

```sh
pnpm verify:snapshot   # Download the public release artifacts and verify SHA-256
pnpm build:snapshot    # Rebuild packages from the exact source commit
```

The rebuild checks out the fork in a temporary directory, installs its locked dependencies, and runs its release preparation and full build. It then assigns the proposal prerelease version and packs the four packages into `.artifacts/`. It needs Git, pnpm, network access, and enough disk space for the full monorepo build. It does not publish anything or change the proposal checkout.

This repository holds the application and compatibility walkthroughs. The Effect branch holds the implementation, permanent JSDoc examples, and regression tests.
