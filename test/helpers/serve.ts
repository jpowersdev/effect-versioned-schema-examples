import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"

// Compatibility tests use real HTTP on loopback, with an OS-selected port. The enclosing
// scope closes the listener after the clients finish.
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
