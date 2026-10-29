import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Person, PersonNotFound } from "../Domain/Person.ts"

export class PeopleApi extends HttpApiGroup.make("people")
  .add(HttpApiEndpoint.get("getById", "/people/:id", {
    params: { id: Schema.String },
    success: Person,
    error: PersonNotFound.annotate({ httpApiStatus: 404 })
  }))
  .add(HttpApiEndpoint.put("save", "/people/:id", {
    params: { id: Schema.String },
    payload: Person,
    success: Person
  }))
{}
