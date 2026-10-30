// Runs a benchmark against the baseline: every `effect` import, including the
// package's imports of itself, resolves to `effect-base`, the unmodified
// package from the commit the proposal is based on.
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "effect" || specifier.startsWith("effect/")) {
      return nextResolve(`effect-base${specifier.slice("effect".length)}`, context)
    }
    return nextResolve(specifier, context)
  }
})
