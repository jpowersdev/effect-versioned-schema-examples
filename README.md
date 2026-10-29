# Versioned schemas for Effect

Runnable examples for the [versioned-schema proposal](https://github.com/jpowersdev/effect/tree/feat/versioned-schema-v2). These use a proposal build, not an official Effect release.

The examples are pinned to [`ee7ab8096f`](https://github.com/jpowersdev/effect/commit/ee7ab8096ffe96ef15bb46a33b41899afc66e0b7). They exercise the public APIs of built packages installed from this repository's [snapshot release](https://github.com/jpowersdev/effect-versioned-schema-examples/releases/tag/snapshot-ee7ab8096f).

## Run

Use Node **24.21.0** and pnpm **11.20.0** (recorded in `.node-version` and `package.json`). No Docker or external database is required.

```sh
git clone https://github.com/jpowersdev/effect-versioned-schema-examples.git
cd effect-versioned-schema-examples
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` typechecks and runs every example. Each example asserts its results, prints what happened, and exits. HTTP listeners and database connections are closed automatically.

| Command | Entry point | Demonstrates |
| --- | --- | --- |
| `pnpm demo:schema` | [Schema and storage](src/schema.ts) | Read old records, write current or explicitly selected versions, reject unrepresentable values, adopt unversioned records |
| `pnpm demo:http` | [HTTP clients and servers](src/http/demo.ts) | Both directions of client/server version skew, explicit retry, the actual JSON wire shape |
| `pnpm demo:rpc` | [RPC clients and servers](src/rpc/demo.ts) | The same compatibility behavior over RPC, plus a stream ending with `Unrepresentable` |
| `pnpm demo:cluster` | [Cluster rollout](src/cluster/demo.ts) | A SQLite-backed mailbox waits for an upgraded runner, preserves per-entity order, and answers each caller at its versions |

## Start with the schema definitions

Three modules represent the schema histories available to three application builds:

- [v1](src/models/v1.ts): `Person` has `name`, `status`, and an `Address` with `street`.
- [v2](src/models/v2.ts): `name` becomes `fullName` using an explicit `custom` migration. `Address` gains optional `city` using `addField`.
- [v3](src/models/v3.ts): `Person` gains optional `email` and an `archived` status using `addField` and `mapField`. Downgrading an archived person returns `unrepresentable`.

The same rename could be expressed with `step.renameField("name", "fullName")`; the explicit v2 migration shows the escape hatch alongside the helpers.

```ts
const Person = V2.Person.next({
  version: 3,
  payload: Schema.Struct({
    fullName: Schema.String,
    status: Schema.Literals(["active", "suspended", "archived"]),
    email: Schema.optionalKey(Schema.String),
    address: V2.Address
  }),
  migration: (step) => step.addField("email").mapField("status", {
    up: (status) => status,
    down: (status) => status === "archived"
      ? VersionedSchema.unrepresentable("An archived person needs Person v3")
      : status
  })
})
```

Decoded values are plain application objects. Encoded records carry `_version`. A normal encode writes the latest version declared by that schema. To write for older storage readers, select versions explicitly:

```ts
Schema.encodeSync(VersionedSchema.at(Person, { Person: 1, Address: 1 }))(person)
```

`Person` and `Address` have independent histories. Selecting an older `Person` does not implicitly select an older nested `Address`. The example pins both. Older writes can deliberately lose fields such as `email` and `city`.

`unversioned: true` adopts existing unmarked records as the first version. Deploy that reader before introducing newer marked records; applications built before adoption do not gain compatibility retroactively.

## HTTP and RPC

The [HTTP API](src/http/api.ts) and [RPC protocol](src/rpc/protocol.ts) use the versioned schemas directly. No separate wire schema or hand-written negotiation middleware is needed. Generated clients declare the schema versions they speak; handlers receive negotiated `versions`.

| Client → server | Result |
| --- | --- |
| v3 → v3 | Current request and response shapes |
| v1 → v3 | Old payloads upgrade on the server; replies encode for the old client |
| v3 → v1, response-only read | The server returns a version it knows; the newer client upgrades it |
| v3 → v1, newer request payload | `VersionUnsupported` before the handler runs |
| Explicit retry at `error.supported` | Compatible values are downgraded and the request succeeds |
| Archived person → v1 client | `Unrepresentable`, because the old status type cannot hold the value |

The retry is application code, and happens only once:

```ts
save.pipe(Effect.catchTag("VersionUnsupported", (error) =>
  save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))
))
```

An `Unrepresentable` response can occur **after** a handler has run. It does not mean its side effects were rolled back, so these examples do not retry that failure. Direct schema encoders return `SchemaError`; the transport integrations expose the typed compatibility errors.

The RPC stream delivers Ada, then fails at Grace's archived status. The HTTP demo also reads a raw response to show the markers that generated clients remove from their decoded values.

Both histories live in one process for this walkthrough. They are distinct schema objects modeling separately deployed application builds. HTTP and RPC requests travel over actual loopback HTTP connections on OS-assigned ports.

## Cluster rollout

The [entity definition](src/cluster/entities.ts) marks `Save` as persisted. The demo creates a temporary, file-backed SQLite mailbox and independent client and runner scopes:

1. Start the v1 runner and send a v3 request for Ada.
2. Observe that request waiting for a compatible runner.
3. Queue a readable v1 request for Ada behind it. Bob's request still runs.
4. Stop the v1 runner while keeping the database and sending client alive.
5. Start the v3 runner. Both Ada requests run in order and receive replies at their respective versions.

The example asserts that no Ada handler ran before the upgrade. It does not translate or discard the queued request. `unknownVersionTimeout` stays at its default, infinity; the demo itself has a timeout so a failed assertion cannot leave it hanging.

This is a single-process rollout walkthrough with SQL polling and an in-memory runner lock store. It demonstrates mailbox persistence across runner replacement, not multi-host coordination or process-crash recovery. The temporary database is removed when the walkthrough finishes. Workflow activity and durable-deferred replay are outside this proposal's cluster integration.

## The package pin

[snapshot.json](snapshot.json) records the full source commit, package versions, build tool versions, and SHA-256 checksums. All four Effect packages come from that commit. `pnpm-workspace.yaml` overrides transitive Effect dependencies to the same artifacts, and the committed lockfile records their integrity hashes.

```sh
pnpm verify:snapshot   # Download the public release artifacts and verify SHA-256
pnpm build:snapshot    # Rebuild packages from the exact source commit
```

The rebuild checks out the fork in a temporary directory, installs its locked dependencies, and runs its release preparation and full build. It then assigns the proposal prerelease version and packs the four packages into `.artifacts/`. It needs Git, pnpm, network access, and enough disk space for the full monorepo build. It does not publish anything or change the proposal checkout.

This repository holds the runnable walkthroughs. The Effect branch holds the implementation, permanent JSDoc examples, and regression tests.
