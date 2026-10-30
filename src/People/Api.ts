import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Person, PersonNotFound } from "../Domain/Person.ts"

export class PeopleApiGroup extends HttpApiGroup.make("people").add(
  HttpApiEndpoint.get("getById", "/people/:id", {
    params: { id: Schema.String },
    success: Person,
    error: PersonNotFound.annotate({ httpApiStatus: 404 })
  }),
  HttpApiEndpoint.put("save", "/people/:id", {
    params: { id: Schema.String },
    payload: Person,
    success: Person
  })
) {}

// This example has one group, so the combined API lives here too.
export class Api extends HttpApi.make("api").add(PeopleApiGroup) {}
