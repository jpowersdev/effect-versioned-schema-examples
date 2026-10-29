import { Effect, Layer, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { PersonNotFound } from "./Domain/Person.ts"
import { PeopleRpcs } from "./Rpcs.ts"
import { ada } from "./Seed.ts"

export const makeLegacyRpc = () => {
  const calls = { saves: 0 }
  const routes = RpcServer.layer(PeopleRpcs).pipe(
    Layer.provide(PeopleRpcs.toLayer({
      GetPerson: ({ id }) => id === "ada" ? Effect.succeed(ada) : Effect.fail(new PersonNotFound({ id })),
      SavePerson: Effect.fn(function*({ person }, { versions }) {
        calls.saves++
        yield* Effect.logInfo("Legacy RPC handler").pipe(Effect.annotateLogs({ versions }))
        return person
      }),
      ListPeople: () => Stream.make(ada)
    })),
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerJson)
  )
  return { routes, calls }
}
