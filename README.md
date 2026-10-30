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
New client writes           { fullName: "Ada", status: "active", email: "ada@example.com" }
HTTP request, Person=3      { _version: 3, fullName: "Ada", status: "active", email: "ada@example.com" }
HTTP response, 400          VersionUnsupported { supported: { Person: 1 } }
                            The old server's handler has not run.
HTTP request, Person=1      { _version: 1, name: "Ada", status: "active" }
Old server handler receives { name: "Ada", status: "active" }
HTTP response, 200          { _version: 1, name: "Ada", status: "active" }
New client receives         { fullName: "Ada", status: "active" }
```

The application explicitly chooses **one retry**, accepting that `email` will be dropped:

```ts
const save = client.people.save({
  params: {
    id: "ada"
  },
  payload: updated
})

save.pipe(
  Effect.catchTag(
    "VersionUnsupported",
    (error) => save.pipe(Effect.provideService(VersionedSchema.ClientVersions, error.supported))
  )
)
```

[src/client.ts](src/client.ts) also logs the rejection before retrying. The transport does not decide whether losing that field is acceptable. That policy stays at the call site.

## 3. A value that cannot be translated

**The new server has an `archived` person. The old client only understands `active | suspended`.**

```sh
pnpm demo:unrepresentable
```

```text
New server returns                { fullName: "Grace", status: "archived" }
HTTP response, 406                Unrepresentable { id: "Person", version: 1, ... }
Old client can't show this person { reason: "Person can't be written at v1: An archived person needs Person v3" }
```

The reverse migration explicitly calls `VersionedSchema.unrepresentable(...)`. It does not invent a fallback status. This request is not retried.

An unrepresentable response can fail **after** a handler has run. It does not roll back any side effects. That is why the retry above handles only `VersionUnsupported`, which rejects the request before its handler runs.

## Read the implementation

All three client scenarios are together in **[src/client.ts](src/client.ts)**, with comments showing what each step logs. The complete Person history is in **[src/Domain/Person.ts](src/Domain/Person.ts)**:

- v1: `name` and `status`.
- v2: rename `name` to `fullName` with `renameField`.
- v3: add optional `email` with `addField`, and extend `status` with `mapField`. The reverse mapping rejects `archived`.

The other modules follow the domain/API/handler layout of [effect-http-play](https://github.com/tim-smart/effect-http-play), with v4 APIs:

| Module                                   | Contents                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| [src/People/Api.ts](src/People/Api.ts)   | The API contract. Clients import it without the server.                |
| [src/People/Http.ts](src/People/Http.ts) | The handlers, which only see the current Person.                       |
| [src/Http.ts](src/Http.ts)               | The server: the routes on a free port, with a client that sends to it. |
| [src/previous.ts](src/previous.ts)       | The previous release: the contract its clients use, and its server.    |
| [src/main.ts](src/main.ts)               | Runs the scenarios.                                                    |

`previous.ts` models code already shipped. It imports nothing from the current domain. Using `VersionedSchema.at(Person, Person.version(1))` instead would only select an older encoding; its decoded type would still be the current Person, so it would not model an old client.

Both servers keep a small in-memory store in their handler layer. `PUT` replaces the whole record. Each scenario starts with fresh data.

## Supporting cases

Each supporting example is one self-contained file that declares its own schemas and servers, with comments showing what each step logs:

| Command                   | What it demonstrates                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm example:onboarding` | [Adopting versioning](examples/onboarding.ts): records and clients from before versioning. Those clients send no version header, so they get the latest version unless the server pins older ones with `VersionedSchema.DefaultVersions`. The pin comes out once every client sends the header. |
| `pnpm example:rpc`        | [RPC compatibility](examples/rpc.ts): the same deployment mismatch and explicit retry, plus a stream that delivers Ada before failing at Grace's archived status.                                                                                                                               |
| `pnpm example:cluster`    | [Queued work during a rollout](examples/cluster.ts): a SQLite mailbox waits for an upgraded runner, holds later work for Ada in order, lets Bob progress, and replies at each caller's version. The handler reads the version each caller sent with `VersionedSchema.requestVersion(Person)`.   |
| `pnpm example:storage`    | [Stored data](examples/storage.ts): read old records, choose write versions, and version nested schemas independently.                                                                                                                                                                          |

The cluster walkthrough uses a temporary SQLite file, SQL polling, and an in-memory runner lock store. It demonstrates persistence across runner replacement within one process; it does not simulate multi-host coordination or a process crash. It leaves `unknownVersionTimeout` out, so messages wait without a limit. The temporary database is removed afterward.

## Performance

Endpoints and RPCs that don't use a versioned schema cost about the same as before: five of six cases show no measurable difference, and Rpc save is about 3.5% slower (1–2 µs). Using a versioned schema adds 8–23 µs per call, and 17–40 µs when the client speaks an older version.

The [benchmarks](benchmarks) time HttpApi and Rpc calls end to end, through the real client, an in-process `fetch` and the real server, with a handler that returns at once and one small Person. They compare the proposal with an unmodified build of the [Effect commit it's based on](https://github.com/Effect-TS/effect/commit/c065ed7b2cd9de19cfd5303114908128a70b309f), published as [snapshot-c065ed7b2c](https://github.com/jpowersdev/effect-versioned-schema-examples/releases/tag/snapshot-c065ed7b2c). These numbers come from [one run](https://github.com/jpowersdev/effect-versioned-schema-examples/actions/runs/41129933827) on a GitHub-hosted runner (AMD EPYC 9V45, 4 threads, Node 24.21.0): 10 rounds, each case in a fresh process, with the two builds taking turns going first. The raw results are in [benchmarks/results.json](benchmarks/results.json).

Without a versioned schema, proposal vs baseline. `build` is building the server and client and making the first call.

| Call          | Baseline | Proposal | Difference (95% interval) |
| ------------- | -------- | -------- | ------------------------- |
| HttpApi get   | 24.5 µs  | 24.4 µs  | -0.2% (-2.2% to +4.5%)    |
| HttpApi save  | 34.1 µs  | 34.7 µs  | +1.4% (-1.4% to +4.9%)    |
| HttpApi build | 438.4 µs | 399.0 µs | -2.1% (-13.3% to +2.0%)   |
| Rpc get       | 58.3 µs  | 59.2 µs  | +1.0% (-3.5% to +6.6%)    |
| Rpc save      | 60.6 µs  | 61.6 µs  | +3.5% (+3.0% to +5.7%)    |
| Rpc build     | 580.0 µs | 590.1 µs | +1.7% (-1.6% to +3.7%)    |

With a versioned schema on the proposal, vs the same call with a plain schema on the baseline:

| Call                       | Baseline, plain schema | Proposal, versioned schema | Difference        |
| -------------------------- | ---------------------- | -------------------------- | ----------------- |
| HttpApi get                | 24.5 µs                | 32.2 µs                    | +7.7 µs (+31.4%)  |
| HttpApi get, client at v1  | 24.5 µs                | 41.4 µs                    | +16.9 µs (+68.9%) |
| HttpApi save               | 34.1 µs                | 46.5 µs                    | +12.4 µs (+36.3%) |
| HttpApi save, client at v1 | 34.1 µs                | 62.3 µs                    | +28.1 µs (+82.4%) |
| HttpApi build              | 438.4 µs               | 518.5 µs                   | +80.0 µs (+18.3%) |
| Rpc get                    | 58.3 µs                | 73.7 µs                    | +15.4 µs (+26.4%) |
| Rpc get, client at v1      | 58.3 µs                | 84.6 µs                    | +26.3 µs (+45.1%) |
| Rpc save                   | 60.6 µs                | 83.5 µs                    | +23.0 µs (+37.9%) |
| Rpc save, client at v1     | 60.6 µs                | 100.4 µs                   | +39.8 µs (+65.8%) |
| Rpc build                  | 580.0 µs               | 651.0 µs                   | +71.0 µs (+12.2%) |

What these numbers do and don't show:

- **The percentages are an upper bound.** There's no network and the handler does no work, so versioning is a large share of a small total. Over a network, with real handlers, the same microseconds are a much smaller share.
- **The versioned cost is for both sides.** It includes writing and reading `_version`, decoding one of three record versions, and negotiation, on the client and the server. A client at v1 adds the migrations in both directions.
- **It grows with the number of versioned values** in a call, such as a list of people. Each case here has one.
- **Cluster's transport is covered, its storage isn't.** Cluster entities use the same Rpc client and server, so the Rpc rows cover their negotiation. Decoding persisted messages isn't measured.
- **The versioned path hasn't been optimized.**
- **The runner is shared cloud hardware.** Single rounds vary, and the intervals in the first table show by how much.

To run them yourself, use `pnpm bench [--rounds n]` locally, or the Benchmark workflow from the Actions tab. Benchmarks are noisy on a busy machine, so run them while it's idle.

## Checks and package pin

```sh
pnpm test
pnpm lint
```

`pnpm test` typechecks every source file, then runs the tests with [`@effect/vitest`](https://github.com/Effect-TS/effect/tree/main/packages/vitest). They check the HTTP scenarios' logged wire bodies, statuses, handler inputs and retries against the traces above, and run each supporting example, checking that its steps happen in order. Each walkthrough has a timeout so a failure cannot leave it hanging.

`pnpm lint` checks formatting with Effect's dprint settings; `pnpm format` applies them.

The examples use an **unreleased proposal build** pinned to [`8fa8f7c1b2`](https://github.com/jpowersdev/effect/commit/8fa8f7c1b24f89d1924abedd6eec838986186fa2), not an official Effect release.

<details>
<summary>Package artifacts and rebuilding</summary>

[snapshot.json](snapshot.json) records the source commit, package versions, build tools, and SHA-256 checksums. The packages are hosted in this repository's [development release](https://github.com/jpowersdev/effect-versioned-schema-examples/releases/tag/snapshot-8fa8f7c1b2). All five Effect packages come from the same commit. The workspace overrides pin transitive dependencies to those tarballs; the lockfile records their integrity hashes.

```sh
pnpm verify:snapshot   # Download the published artifacts, including the benchmark baseline, and verify SHA-256
pnpm build:snapshot    # Rebuild from the exact source commit into .artifacts/<version>/
```

The rebuild uses a temporary checkout and the fork's locked dependencies and release preparation. It requires Git, pnpm, network access, and disk space for a full Effect build. It does not publish anything or modify the proposal checkout.

</details>
