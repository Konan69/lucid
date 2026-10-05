import type { ConversationId as PiConversationId } from '@earendil-works/pi-durable'
import { Predicate, Schema } from 'effect'

/** Pi's types.ts Id is an erased numeric brand; retain that identity in the shared error contract. */
const ConversationId = Schema.declare<PiConversationId>((value): value is PiConversationId =>
  Predicate.isNumber(value),
)

/** The harness owns conversation identity; errors retain the requested identifier verbatim. */
export class ConversationMissing extends Schema.TaggedError<ConversationMissing>()(
  'ConversationMissing',
  { conversationId: ConversationId },
  { title: 'ConversationMissing' },
) {}

/** One rejected Pi call, distinguished by the public operation rather than its error text. */
export class PiFailed extends Schema.TaggedError<PiFailed>()(
  'PiFailed',
  {
    operation: Schema.Literals([
      'conversation',
      'snapshot',
      'commit',
      'submit',
      'watch',
      'agent',
      'context',
    ]),
    cause: Schema.Defect(),
  },
  { title: 'PiFailed' },
) {}

/** The latest chat message cannot start or resume a run. */
export class TurnInvalid extends Schema.TaggedError<TurnInvalid>()(
  'TurnInvalid',
  {},
  { title: 'TurnInvalid' },
) {}

/** None of the stored assistant messages made the tool calls named by a resume. */
export class RunMissing extends Schema.TaggedError<RunMissing>()(
  'RunMissing',
  {
    conversationId: ConversationId,
  },
  { title: 'RunMissing' },
) {}

/** The AI SDK could not derive the JSON Schema Pi needs to register this tool. */
export class ToolSchemaFailed extends Schema.TaggedError<ToolSchemaFailed>()(
  'ToolSchemaFailed',
  {
    toolName: Schema.String,
    cause: Schema.Defect(),
  },
  { title: 'ToolSchemaFailed' },
) {}
