import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Person, PersonNotFound } from "./Domain/Person.ts"

export class PeopleRpcs extends RpcGroup.make(
  Rpc.make("GetPerson", { payload: { id: Schema.String }, success: Person, error: PersonNotFound }),
  Rpc.make("SavePerson", { payload: { id: Schema.String, person: Person }, success: Person }),
  Rpc.make("ListPeople", { success: Person, stream: true })
) {}
