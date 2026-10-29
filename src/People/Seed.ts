import type { Person } from "../Domain/Person.ts"

export const ada: Person = {
  fullName: "Ada",
  status: "active",
  email: "ada@example.com",
  address: { street: "1 Main St", city: "London" }
}

export const grace: Person = {
  fullName: "Grace",
  status: "archived",
  address: { street: "2 Main St" }
}
