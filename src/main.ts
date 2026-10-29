import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpLive } from "./Http.ts"

HttpLive.pipe(Layer.launch, NodeRuntime.runMain)
