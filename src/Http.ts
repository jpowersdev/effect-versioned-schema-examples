import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { createServer } from "node:http"
import { Api } from "./People/Api.ts"
import { HttpPeopleLive } from "./People/Http.ts"

export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(HttpPeopleLive))

// Serves routes on a free loopback port until the scope closes, so each
// scenario runs without starting or configuring another process.
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
