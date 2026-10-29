import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../Api.ts"
import { People } from "../People.ts"

export const HttpPeopleLive = HttpApiBuilder.group(
  Api,
  "people",
  Effect.fn(function*(handlers) {
    const people = yield* People

    return handlers
      .handle("getById", ({ params }) => people.getById(params.id))
      .handle(
        "save",
        Effect.fn(function*({ params, payload, versions }) {
          yield* Effect.logInfo("Saving person over HTTP").pipe(
            Effect.annotateLogs({ personId: params.id, versions })
          )
          // payload is the current Person; the transport handles the wire version.
          return yield* people.save(params.id, payload)
        })
      )
  })
)
