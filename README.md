# Deploy clients and servers independently

An old mobile app should keep working after its API upgrades. A new frontend should be able to talk to an API instance that has not upgraded yet. When a value cannot be translated faithfully, the caller should get an explicit failure.

These examples demonstrate those three cases using the [Effect versioned-schema proposal](https://github.com/jpowersdev/effect/tree/feat/versioned-schema-v2). The server handlers work with their own current model; declared schema migrations translate at the boundary.

## Try it

Use Node **24.21.0** and pnpm **11.20.0**. No separate server process, Docker, or database setup is required.

```sh
git clone https://github.com/jpowersdev/effect-versioned-schema-examples.git
cd effect-versioned-schema-examples
pnpm install --frozen-lockfile
pnpm demo
```

The command runs all three scenarios and exits. Each starts real HTTP listeners on free loopback ports, logs the client's value, actual request and response bodies, and handler value using `Effect.logInfo`, then closes the listeners. The old and new applications are represented by separate contracts in one process.

## 1. Old client, new server

**The API renamed `name` to `fullName`. The installed mobile client still uses `name`.**

```sh
pnpm demo:old-client
```

The trace shows:

```text
Old client sends            { name: "Ada Lovelace", status: "active" }
HTTP request, Person=1      { _version: 1, name: "Ada Lovelace", status: "active" }
New server handler receives { fullName: "Ada Lovelace", status: "active" }
HTTP response, 200          { _version: 1, name: "Ada Lovelace", status: "active" }
Old client receives         { name: "Ada Lovelace", status: "active" }
```

The request upgrades before the handler runs. The response downgrades for the caller. The old client keeps its original type, while the new handler only deals with `fullName`.

## 2. New client, old server

**The frontend has deployed, but a request lands on an older API instance.**

```sh
pnpm demo:old-server
```

A read succeeds immediately: the old server returns `{ name: "Ada", status: "active" }` at v1, and the new client decodes it to `{ fullName: "Ada", status: "active" }`.

For a write, the new client sends `fullName` and a new optional `email` field:

```text
New client writes at v3    { fullName: "Ada", status: "active", email: "ada@example.com" }
Old server responds, 400   VersionUnsupported { supported: { Person: 1 } }
                          The handler has not run.
Application retries at v1  { _version: 1, name: "Ada", status: "active" }
Old server handler sees   { name: "Ada", status: "active" }
New client receives       { fullName: "Ada", status: "active" }
```

The application explicitly chooses **one retry**, accepting that `email` will be dropped:

```ts
save.pipe(
  Effect.catchTag(
    "VersionUnsupported",
    (error) => save.pipe(Effect.provideService(VersionedSchema.Versions, error.supported))
  )
)
```

The transport does not decide whether losing that field is acceptable. That policy stays at the call site.

## 3. A value that cannot be translated

**The new server has an `archived` person. The old client only understands `active | suspended`.**

```sh
pnpm demo:unrepresentable
```

```text
New server returns    { fullName: "Grace", status: "archived" }
HTTP response, 406    Unrepresentable { id: "Person", version: 1, ... }
Old client receives  A typed Unrepresentable failure
```

The reverse migration explicitly calls `VersionedSchema.unrepresentable(...)`. It does not invent a fallback status. This request is not retried.

An unrepresentable response can fail **after** a handler has run. It does not roll back any side effects. That is why the retry above handles only `VersionUnsupported`, which rejects the request before its handler runs.

## Read the implementation

All three client scenarios are together in **[src/client.ts](src/client.ts)**. The complete Person history is in **[src/Domain/Person.ts](src/Domain/Person.ts)**:

- v1: `name` and `status`.
- v2: rename to `fullName` with an explicit `custom` migration. `step.renameField("name", "fullName")` is the equivalent helper.
- v3: add optional `email` with `addField`, and extend `status` with `mapField`. The reverse mapping rejects `archived`.

The HTTP example has **six source modules**. The other four are the [API contract](src/People/Api.ts), [handlers and HTTP wiring](src/People/Http.ts), [frozen old contracts](src/legacy.ts), and [runner](src/main.ts). It uses the domain/API/handler conventions from [effect-http-play](https://github.com/tim-smart/effect-http-play), with v4 APIs. Clients import contracts separately from server implementations.

`legacy.ts` models code already shipped to users. It imports nothing from the current schema. Using `VersionedSchema.at(Person, { Person: 1 })` would only select an older encoding; its decoded type would still be the current Person, so it would not model an old client.

Both servers use a small in-memory store in their handler layer. `PUT` replaces the whole record. Data resets between scenarios.

## Supporting cases

Each supporting example is contained in one file and runs independently:

| Command                | What it demonstrates                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm example:rpc`     | [RPC compatibility](examples/rpc.ts): the same deployment mismatch and explicit retry, plus a stream that delivers Ada before failing at Grace's archived status.                               |
| `pnpm example:cluster` | [Queued work during a rollout](examples/cluster.ts): a SQLite mailbox waits for an upgraded runner, holds later work for Ada in order, lets Bob progress, and replies at each caller's version. |
| `pnpm example:storage` | [Stored data](examples/storage.ts): read old records, choose write versions, version nested schemas independently, and adopt existing unmarked records.                                         |

The cluster walkthrough uses a temporary SQLite file, SQL polling, and an in-memory runner lock store. It demonstrates persistence across runner replacement within one process; it does not simulate multi-host coordination or a process crash. `unknownVersionTimeout` remains infinite. The temporary database is removed afterward.

## Checks and package pin

```sh
pnpm test
```

This typechecks every source file and verifies the HTTP scenarios' wire bodies, statuses, handler inputs, and retry counts. It also runs the supporting examples' assertions. Each walkthrough has a timeout so a failure cannot leave it hanging.

The examples use an **unreleased proposal build** pinned to [`ee7ab8096f`](https://github.com/jpowersdev/effect/commit/ee7ab8096ffe96ef15bb46a33b41899afc66e0b7), not an official Effect release.

<details>
<summary>Package artifacts and rebuilding</summary>

[snapshot.json](snapshot.json) records the source commit, package versions, build tools, and SHA-256 checksums. The packages are hosted in this repository's [development release](https://github.com/jpowersdev/effect-versioned-schema-examples/releases/tag/snapshot-ee7ab8096f). All four Effect packages come from the same commit. The workspace overrides pin transitive dependencies to those tarballs; the lockfile records their integrity hashes.

```sh
pnpm verify:snapshot   # Download the published artifacts and verify SHA-256
pnpm build:snapshot    # Rebuild from the exact source commit into .artifacts/
```

The rebuild uses a temporary checkout and the fork's locked dependencies and release preparation. It requires Git, pnpm, network access, and disk space for a full Effect build. It does not publish anything or modify the proposal checkout.

</details>
