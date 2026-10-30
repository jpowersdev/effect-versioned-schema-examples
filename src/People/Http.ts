import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Ref } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { createServer } from "node:http"
import { type Person, PersonNotFound } from "../Domain/Person.ts"
import { Api as LegacyApi, type Person as LegacyPerson, PersonNotFound as LegacyPersonNotFound } from "../legacy.ts"
import { Api } from "./Api.ts"

// Current application. The handlers only use the current Person type.
export const HttpPeopleLive = HttpApiBuilder.group(
  Api,
  "people",
  Effect.fn(function*(handlers) {
    const people = yield* Ref.make<ReadonlyMap<string, Person>>(
      new Map([
        ["ada", { fullName: "Ada", status: "active" }],
        ["grace", { fullName: "Grace", status: "archived" }]
      ])
    )

    return handlers
      .handle(
        "getById",
        Effect.fn(function*({ params }) {
          const person = (yield* Ref.get(people)).get(params.id)
          if (person === undefined) return yield* new PersonNotFound({ id: params.id })
          yield* Effect.logInfo("New server returns", person)
          return person
        })
      )
      .handle(
        "save",
        Effect.fn(function*({ params, payload }) {
          yield* Effect.logInfo("New server handler receives", payload)
          yield* Ref.update(people, (current) => new Map(current).set(params.id, payload))
          return payload
        })
      )
  })
)

export const Routes = HttpApiBuilder.layer(Api).pipe(Layer.provide(HttpPeopleLive))

// The already-deployed server still works with name, not fullName.
const HttpLegacyPeopleLive = HttpApiBuilder.group(
  LegacyApi,
  "people",
  Effect.fn(function*(handlers) {
    const people = yield* Ref.make<ReadonlyMap<string, LegacyPerson>>(
      new Map([
        ["ada", { name: "Ada", status: "active" }]
      ])
    )

    return handlers
      .handle(
        "getById",
        Effect.fn(function*({ params }) {
          const person = (yield* Ref.get(people)).get(params.id)
          if (person === undefined) return yield* new LegacyPersonNotFound({ id: params.id })
          yield* Effect.logInfo("Old server returns", person)
          return person
        })
      )
      .handle(
        "save",
        Effect.fn(function*({ params, payload }) {
          yield* Effect.logInfo("Old server handler receives", payload)
          yield* Ref.update(people, (current) => new Map(current).set(params.id, payload))
          return payload
        })
      )
  })
)

export const LegacyRoutes = HttpApiBuilder.layer(LegacyApi).pipe(Layer.provide(HttpLegacyPeopleLive))

// Real loopback listeners close with the scenario's scope. Random ports let
// each command run without manually starting or configuring another process.
export const serve = <A, E, R>(routes: Layer.Layer<A, E, R>) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
      )
    )
    const { address } = Context.get(context, HttpServer.HttpServer)
    if (address._tag === "UnixPathAddress") return yield* Effect.die("Expected a TCP listener")
    return `http://127.0.0.1:${address.port}`
  })
