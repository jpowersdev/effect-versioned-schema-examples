import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"

const protocol = <P extends Schema.Top>(person: P) =>
  RpcGroup.make(
    Rpc.make("GetPerson", { payload: { id: Schema.String }, success: person }),
    Rpc.make("SavePerson", { payload: { person }, success: person }),
    Rpc.make("ListPeople", { success: person, stream: true })
  )

export const PeopleV1 = protocol(V1.Person)
export const PeopleV3 = protocol(V3.Person)
