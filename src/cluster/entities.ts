import { Schema } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"

const entity = <P extends Schema.Top>(person: P) =>
  Entity.make("People", [
    Rpc.make("Save", { payload: { operation: Schema.String, person }, success: person })
  ]).annotateRpcs(ClusterSchema.Persisted, true)

export const PeopleV1 = entity(V1.Person)
export const PeopleV3 = entity(V3.Person)
