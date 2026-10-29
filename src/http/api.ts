import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import * as V1 from "../models/v1.ts"
import * as V3 from "../models/v3.ts"

const makeApi = <P extends Schema.Top>(person: P) =>
  HttpApi.make("people").add(
    HttpApiGroup.make("people")
      .add(HttpApiEndpoint.get("get", "/people/:id", { params: { id: Schema.String }, success: person }))
      .add(HttpApiEndpoint.put("save", "/people", { payload: person, success: person }))
  )

// The endpoint definitions are identical; each build imports its own schema.
export const ApiV1 = makeApi(V1.Person)
export const ApiV3 = makeApi(V3.Person)
