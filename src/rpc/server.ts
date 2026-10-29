import { Effect, Layer, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"
import { PeopleV1, PeopleV3 } from "./protocol.ts"

export const makeServers = () => {
  const calls = { oldSaves: 0 }
  const old = RpcServer.layer(PeopleV1).pipe(
    Layer.provide(PeopleV1.toLayer({
      GetPerson: () => Effect.succeed(V1.ada),
      SavePerson: ({ person }, { versions }) =>
        Effect.sync(() => {
          calls.oldSaves++
          console.log("v1 RPC handler negotiated:", versions)
          return person
        }),
      ListPeople: () => Stream.make(V1.ada)
    })),
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson)
  )
  const current = RpcServer.layer(PeopleV3).pipe(
    Layer.provide(PeopleV3.toLayer({
      GetPerson: ({ id }) => Effect.succeed(id === "archived" ? V3.archived : V3.ada),
      SavePerson: ({ person }, { versions }) =>
        Effect.sync(() => {
          console.log("v3 RPC handler negotiated:", versions)
          return person
        }),
      ListPeople: () => Stream.make(V3.ada, V3.archived)
    })),
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson)
  )
  return { old, current, calls }
}
