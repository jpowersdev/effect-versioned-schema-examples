import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { createServer } from "node:http"
import { Api } from "./People/Api.ts"
import { PeopleApiHandlers } from "./People/Http.ts"

export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(PeopleApiHandlers)
)

// Serves routes on a free loopback port until the scope closes, and returns
// their base URL. Each scenario runs without starting another process.
export const serve = <A, E, R>(routes: Layer.Layer<A, E, R>) =>
  Effect.gen(function*() {
    const ServerLayer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
    )
    const context = yield* Layer.build(ServerLayer)

    const { address } = Context.get(context, HttpServer.HttpServer)
    if (address._tag === "UnixPathAddress") {
      return yield* Effect.die("Expected a TCP listener")
    }

    return `http://127.0.0.1:${address.port}`
  })
