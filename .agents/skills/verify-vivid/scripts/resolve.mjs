/** The packages the verify scripts import that only workspace packages depend on (`loader.mjs`). */
const borrowed = /^(?:@vivid\/contracts|@earendil-works\/chord)(?:\/|$)/u

let parent

/** Receives the package whose dependencies resolve the borrowed names. */
export function initialize(data) {
  parent = data.parent
}

/** Resolves a borrowed name as that package would; every other specifier is left as it is. */
export function resolve(specifier, context, next) {
  return borrowed.test(specifier)
    ? next(specifier, { ...context, parentURL: parent })
    : next(specifier, context)
}
