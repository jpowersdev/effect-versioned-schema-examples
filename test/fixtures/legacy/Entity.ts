import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { Person } from "./Domain/Person.ts"

export const PersonEntity = Entity.make("People", [
  Rpc.make("Save", { payload: { person: Person }, success: Person })
]).annotateRpcs(ClusterSchema.Persisted, true)
