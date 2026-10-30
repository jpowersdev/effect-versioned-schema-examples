import { Effect, Ref } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { type Person, PersonNotFound } from "../Domain/Person.ts"
import { Api } from "./Api.ts"

// The handlers only use the current Person type. HttpApi translates to and
// from the version each client asked for.
export const PeopleApiHandlers = HttpApiBuilder.group(
  Api,
  "people",
  Effect.fn(function*(handlers) {
    const people = yield* Ref.make<ReadonlyMap<string, Person>>(
      new Map([
        ["ada", { fullName: "Ada", status: "active" }],
        ["grace", { fullName: "Grace", status: "archived" }]
      ])
    )

    return handlers.handleAll({
      getById: Effect.fn(function*({ params }) {
        const person = (yield* Ref.get(people)).get(params.id)
        if (person === undefined) {
          return yield* new PersonNotFound({ id: params.id })
        }

        yield* Effect.logInfo("New server returns", person)
        return person
      }),
      save: Effect.fn(function*({ params, payload }) {
        yield* Effect.logInfo("New server handler receives", payload)
        yield* Ref.update(people, (current) => new Map(current).set(params.id, payload))
        return payload
      })
    })
  })
)
