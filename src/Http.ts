import { NodeHttpServer } from "@effect/platform-node"
import { Config, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { Api } from "./Api.ts"
import { People } from "./People.ts"
import { HttpPeopleLive } from "./People/Http.ts"
import { RpcPeopleLive } from "./People/Rpc.ts"
import { PeopleRpcs } from "./People/Rpcs.ts"

export const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(HttpPeopleLive)
)

export const RpcRoutes = RpcServer.layer(PeopleRpcs).pipe(
  Layer.provide(RpcPeopleLive),
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson)
)

// HTTP and RPC use the same People service instance.
export const Routes = Layer.mergeAll(ApiRoutes, RpcRoutes).pipe(Layer.provide(People.layer))

export const HttpLive = HttpRouter.serve(Routes).pipe(
  Layer.provide(NodeHttpServer.layerConfig(createServer, {
    host: Config.succeed("127.0.0.1"),
    port: Config.Number("PORT").pipe(Config.withDefault(3000))
  }))
)
