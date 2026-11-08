import * as Schema from 'effect/Schema'

/**
 * Where an Integration call names one of the Thread's documents instead of carrying its text: a
 * JSON value that is exactly `{"$document": "<title>"}`, at any depth of the call's input.
 *
 * It exists so that the text sent is the text the Person can still revise. Vivid writes a letter
 * as a document, the Person edits it, and the send goes out with their edit: the model never pastes
 * a body it read earlier, and the server copies the newest version in at the moment the call is
 * prepared, recording which version it copied (`ApprovalPrecondition.ArtifactVersion`) so that an
 * Approval asked over it goes stale when the document changes again.
 *
 * Only the exact one-key shape counts. An object with `$document` beside other keys is ordinary
 * input and passes through untouched, so no provider field can be mistaken for a reference.
 */
const Reference = Schema.Struct({ $document: Schema.String })
const isObject = Schema.is(Schema.JsonObject)
const isArray = Schema.is(Schema.Array(Schema.Json))
const hasReferenceKey = Schema.is(Reference)
const isReference = (value: Schema.Json): value is typeof Reference.Type =>
  isObject(value) && Object.keys(value).length === 1 && hasReferenceKey(value)

/** Every document title the input names, in the order they appear, each once. */
export const namedDocuments = (input: Schema.Json): ReadonlyArray<string> => {
  const titles = new Set<string>()
  const walk = (value: Schema.Json): void => {
    if (isReference(value)) titles.add(value.$document)
    else if (isArray(value)) value.forEach(walk)
    else if (isObject(value)) Object.values(value).forEach(walk)
  }
  walk(input)
  return [...titles]
}

/** The input with every reference replaced by the text `bodies` holds for its title. */
export const fillDocuments = (
  input: Schema.Json,
  bodies: ReadonlyMap<string, string>,
): Schema.Json => {
  const fill = (value: Schema.Json): Schema.Json => {
    if (isReference(value)) {
      const body = bodies.get(value.$document)
      // `bindDocuments` reads a body for every title `namedDocuments` found before filling.
      return body === undefined ? value : body
    }
    if (isArray(value)) return value.map(fill)
    if (isObject(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]))
    return value
  }
  return fill(input)
}
