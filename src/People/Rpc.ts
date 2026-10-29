import { Effect, Stream } from "effect"
import { People } from "../People.ts"
import { PeopleRpcs } from "./Rpcs.ts"

export const RpcPeopleLive = PeopleRpcs.toLayer(Effect.gen(function*() {
  const people = yield* People

  return PeopleRpcs.of({
    GetPerson: ({ id }) => people.getById(id),
    SavePerson: Effect.fn(function*({ id, person }, { versions }) {
      yield* Effect.logInfo("Saving person over RPC").pipe(
        Effect.annotateLogs({ personId: id, versions })
      )
      return yield* people.save(id, person)
    }),
    ListPeople: () => Stream.fromEffect(people.list).pipe(Stream.flatMap(Stream.fromIterable))
  })
}))
