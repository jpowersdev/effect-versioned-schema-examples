import { Context, Effect, Layer, Ref } from "effect"
import { type Person, PersonNotFound } from "./Domain/Person.ts"
import { ada, grace } from "./People/Seed.ts"

export class People extends Context.Service<People, {
  readonly getById: (id: string) => Effect.Effect<Person, PersonNotFound>
  readonly save: (id: string, person: Person) => Effect.Effect<Person>
  readonly list: Effect.Effect<ReadonlyArray<Person>>
}>()("app/People") {
  // An in-memory store keeps the application runnable without a database.
  // Handlers depend on this service, not on the storage implementation.
  static readonly layer = Layer.effect(
    People,
    Effect.gen(function*() {
      const records = yield* Ref.make<ReadonlyMap<string, Person>>(
        new Map([
          ["ada", ada],
          ["grace", grace]
        ])
      )

      const getById = Effect.fn("People.getById")(function*(id: string) {
        const person = (yield* Ref.get(records)).get(id)
        if (person === undefined) return yield* new PersonNotFound({ id })
        return person
      })

      const save = Effect.fn("People.save")(function*(id: string, person: Person) {
        yield* Ref.update(records, (current) => new Map(current).set(id, person))
        return person
      })

      return People.of({
        getById,
        save,
        list: Ref.get(records).pipe(Effect.map((current) => Array.from(current.values())))
      })
    })
  )
}
