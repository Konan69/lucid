import { Schema } from 'effect'

/** Exact-edit refusals are distinct from Computer transport failures and never trigger a write. */
export class EditTextEmpty extends Schema.TaggedError<EditTextEmpty>()(
  'EditTextEmpty',
  {
    message: Schema.String,
  },
  { title: 'Edit Text Empty' },
) {}
export class EditTextMissing extends Schema.TaggedError<EditTextMissing>()(
  'EditTextMissing',
  {
    path: Schema.String,
    message: Schema.String,
  },
  { title: 'Edit Text Missing' },
) {}
export class EditTextAmbiguous extends Schema.TaggedError<EditTextAmbiguous>()(
  'EditTextAmbiguous',
  {
    path: Schema.String,
    count: Schema.Finite,
    message: Schema.String,
  },
  { title: 'Edit Text Ambiguous' },
) {}
/** Reading outside the file is an input refusal, not a failed filesystem operation. */
export class ReadOffsetInvalid extends Schema.TaggedError<ReadOffsetInvalid>()(
  'ReadOffsetInvalid',
  {
    path: Schema.String,
    message: Schema.String,
  },
  { title: 'Read Offset Invalid' },
) {}
/** A search exit above one is a failed command; exit one is an ordinary empty search. */
export class SearchFailed extends Schema.TaggedError<SearchFailed>()(
  'SearchFailed',
  {
    message: Schema.String,
  },
  { title: 'Search Failed' },
) {}
/** The invocation deadline differs from a parent abort, which Pi must record as aborted. */
export class ToolDeadline extends Schema.TaggedError<ToolDeadline>()(
  'ToolDeadline',
  {
    message: Schema.String,
  },
  { title: 'Tool Deadline' },
) {}
/** Serialization fails after an action, so its result must explicitly refuse blind repetition. */
export class ToolOutputInvalid extends Schema.TaggedError<ToolOutputInvalid>()(
  'ToolOutputInvalid',
  {
    message: Schema.String,
  },
  { title: 'Tool Output Invalid' },
) {}
/** Missing invocation-local authority is a runtime wiring failure, never model-selected scope. */
export class ToolScopeMissing extends Schema.TaggedError<ToolScopeMissing>()(
  'ToolScopeMissing',
  {
    message: Schema.String,
  },
  { title: 'Tool Scope Missing' },
) {}
