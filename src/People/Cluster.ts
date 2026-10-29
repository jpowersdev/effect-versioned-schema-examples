import { Effect } from "effect"
import { Entity } from "effect/cluster"
import { People } from "../People.ts"
import { PersonEntity } from "./Entity.ts"

export const ClusterPeopleLive = PersonEntity.toLayer(Effect.gen(function*() {
  const people = yield* People
  const { entityId } = yield* Entity.CurrentAddress

  return PersonEntity.of({
    Save: Effect.fn(function*({ payload, versions }) {
      yield* Effect.logInfo("Saving person from the mailbox").pipe(
        Effect.annotateLogs({ personId: entityId, versions })
      )
      return yield* people.save(entityId, payload.person)
    })
  })
}))
