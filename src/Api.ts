import { HttpApi } from "effect/http-api"
import { PeopleApi } from "./People/Api.ts"

export class Api extends HttpApi.make("api").add(PeopleApi) {}
