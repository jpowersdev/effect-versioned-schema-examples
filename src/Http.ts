import { NodeHttpServer } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "./People/Api.ts"
import { PeopleApiHandlers } from "./People/Http.ts"

const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(PeopleApiHandlers)
)

// An HTTP server on a free port, with an HttpClient that sends requests to it.
// The server's own request logs are left out.
export const HttpServerLayer = HttpRouter.serve(ApiRoutes, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest)
)
