import { defineTool } from '@flue/runtime'
import { Shown, WEB_ADDRESS } from '@vivid/contracts'
import * as v from 'valibot'

/** Match the contract's length-only rule; trimming would reject valid display input. */
function line(description: string) {
  return v.pipe(
    v.string('Use text.'),
    v.minLength(1, 'Use at least one character.'),
    v.maxLength(200, 'Use at most 200 characters.'),
    v.description(`${description} Between 1 and 200 characters.`),
  )
}

/** Cells and explanatory text may be empty, unlike labels and titles. */
function words(description: string) {
  return v.pipe(v.string(), v.maxLength(2000), v.description(description))
}

/** Surfaces decode these exact capitalized tags directly from the tool input. */
function tag<const Kind extends Shown['_tag']>(kind: Kind) {
  return v.pipe(v.literal(kind), v.description('Display kind; use this exact spelling.'))
}

/** Links and pictures open and load on every surface, so only web addresses are accepted. */
function address(description: string) {
  return v.pipe(
    v.string(),
    v.maxLength(2000),
    v.regex(WEB_ADDRESS, 'Use a full web address starting with https:// or http://.'),
    v.description(description),
  )
}

const title = v.exactOptional(line('A short heading; omit when unnecessary.'))

const comparisonRules = {
  good: 'Provide the good array; use [] when there are no advantages.',
  bad: 'Provide the bad array; use [] when there are no drawbacks.',
  facts: 'Provide the facts array; use [] when there are no attributes.',
}

/** Valibot reports absent keys at the containing object, before visiting the array schema. */
function comparisonIssue(issue: v.BaseIssue<unknown>) {
  const [path] = issue.path ?? []
  const rule = Object.entries(comparisonRules).find(
    ([key]) => path !== undefined && key === path.key,
  )
  return rule === undefined
    ? 'Provide each comparison item as an object with name, good, bad and facts.'
    : rule[1]
}

/**
 * Flue requires Valibot at model ingress. Keep every field and bound aligned with Shown;
 * the mapped type makes adding a contract kind fail here until its model schema exists.
 * exactOptional mirrors optionalKey: an absent key is valid, explicit undefined is not.
 */
const kinds = {
  Table: v.pipe(
    v.object({
      _tag: tag('Table'),
      title,
      columns: v.pipe(
        v.array(line('A column heading.')),
        v.minLength(1),
        v.maxLength(8),
        v.description('Headings in the order cells appear.'),
      ),
      rows: v.pipe(
        v.array(
          v.pipe(
            v.array(words('A cell, with numbers written as they should read.')),
            v.maxLength(8),
            v.description('One row, with one cell per column in order.'),
          ),
        ),
        v.maxLength(60),
        v.description('The rows to show; at most 60.'),
      ),
      note: v.exactOptional(words('Context or a caveat below the table.')),
    }),
    v.description('Compare values across the same columns.'),
  ),
  Chart: v.pipe(
    v.object({
      _tag: tag('Chart'),
      title,
      kind: v.pipe(
        v.picklist(['bar', 'line', 'share']),
        v.description('Bar compares categories; line shows time; share shows parts of a whole.'),
      ),
      labels: v.pipe(
        v.array(line('A category, time label, or part name.')),
        v.minLength(1),
        v.maxLength(60),
        v.description('Labels shared by all series, in value order.'),
      ),
      series: v.pipe(
        v.array(
          v.object({
            name: line('The name of this series.'),
            values: v.pipe(
              v.array(v.pipe(v.number(), v.finite(), v.description('A finite numeric value.'))),
              v.minLength(1),
              v.maxLength(60),
              v.description('One value per label in the same order.'),
            ),
          }),
        ),
        v.minLength(1),
        v.maxLength(6),
        v.description('Named series sharing the same labels.'),
      ),
      unit: v.exactOptional(
        v.pipe(
          v.string(),
          v.maxLength(12),
          v.description('Suffix after each value, such as % or hrs.'),
        ),
      ),
    }),
    v.description('Show numbers over time, by category, or as parts of a whole.'),
  ),
  Steps: v.pipe(
    v.object({
      _tag: tag('Steps'),
      title,
      steps: v.pipe(
        v.array(
          v.object({
            label: line('The step or outcome.'),
            state: v.pipe(
              v.picklist(['to do', 'doing', 'done', 'skipped']),
              v.description('The actual current progress of this step.'),
            ),
            detail: v.exactOptional(words('Useful context for this step.')),
          }),
        ),
        v.minLength(1),
        v.maxLength(30),
        v.description('Plan or progress steps in order.'),
      ),
    }),
    v.description('Show a plan or the progress of work.'),
  ),
  Options: v.pipe(
    v.object({
      _tag: tag('Options'),
      question: line('The choice the Person needs to make.'),
      options: v.pipe(
        v.array(
          v.object({
            label: line('A short choice.'),
            detail: v.exactOptional(words('What choosing this means.')),
          }),
        ),
        v.minLength(2),
        v.maxLength(8),
        v.description('Between two and eight choices for the Person.'),
      ),
      many: v.pipe(v.boolean(), v.description('Whether the Person may pick more than one.')),
    }),
    v.description('Ask the Person to choose, then wait for their next message.'),
  ),
  Comparison: v.pipe(
    v.object({
      _tag: tag('Comparison'),
      title,
      items: v.pipe(
        v.array(
          v.object(
            {
              name: line('The item being compared.'),
              summary: v.exactOptional(words('A short overview of this item.')),
              good: v.pipe(
                v.array(line('An advantage.'), comparisonRules.good),
                v.maxLength(6, 'Use at most six advantages.'),
                v.description(
                  'Required good array, including [] when there are no advantages; at most six.',
                ),
              ),
              bad: v.pipe(
                v.array(line('A drawback.'), comparisonRules.bad),
                v.maxLength(6, 'Use at most six drawbacks.'),
                v.description(
                  'Required bad array, including [] when there are no drawbacks; at most six.',
                ),
              ),
              facts: v.pipe(
                v.array(
                  v.object({
                    label: line('An attribute.'),
                    value: line('Its value for this item.'),
                  }),
                  comparisonRules.facts,
                ),
                v.maxLength(8, 'Use at most eight attributes.'),
                v.description(
                  'Required facts array, including [] when empty; at most eight label/value attributes, each 1–200 characters.',
                ),
              ),
            },
            comparisonIssue,
          ),
        ),
        v.minLength(2),
        v.maxLength(5),
        v.description(
          'Between two and five things to compare. Every item must include name, good, bad and facts; empty arrays are valid.',
        ),
      ),
      pick: v.exactOptional(
        v.pipe(
          v.object({
            name: line('The exact item name recommended.'),
            why: words('Why, in one sentence.'),
          }),
          v.description('Your recommendation; omit when you would not pick.'),
        ),
      ),
    }),
    v.description('Compare alternatives, their attributes, and their tradeoffs.'),
  ),
  Links: v.pipe(
    v.object({
      _tag: tag('Links'),
      title,
      links: v.pipe(
        v.array(
          v.object({
            title: line('The source or page title.'),
            address: address('The source address, starting with https://.'),
            note: v.exactOptional(words('Why this source is worth opening.')),
          }),
        ),
        v.minLength(1),
        v.maxLength(12),
        v.description('Sources to open, in useful order.'),
      ),
    }),
    v.description('Show sources or useful links.'),
  ),
  Facts: v.pipe(
    v.object({
      _tag: tag('Facts'),
      title,
      facts: v.pipe(
        v.array(
          v.object({
            label: line('What this fact measures or describes.'),
            value: line('The value, written as it should read.'),
            change: v.exactOptional(line('How it moved, such as +12% this week.')),
            tone: v.exactOptional(
              v.pipe(
                v.picklist(['good', 'bad']),
                v.description('Whether the movement is good or bad for the Person.'),
              ),
            ),
          }),
        ),
        v.minLength(1),
        v.maxLength(8),
        v.description('Several facts to read at a glance.'),
      ),
    }),
    v.description('Show several concise facts at a glance.'),
  ),
  Draft: v.pipe(
    v.object({
      _tag: tag('Draft'),
      kind: v.pipe(
        v.picklist(['email', 'message', 'post', 'document']),
        v.description('What is drafted; this does not send it.'),
      ),
      to: v.pipe(
        v.array(line('A recipient name or address.')),
        v.maxLength(20),
        v.description('Recipients; empty when none apply.'),
      ),
      subject: v.exactOptional(line('The subject or heading, when needed.')),
      body: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(20_000),
        v.description('The complete draft for the Person to review.'),
      ),
    }),
    v.description('Offer a draft to review or send, then wait for the Person.'),
  ),
  Schedule: v.pipe(
    v.object({
      _tag: tag('Schedule'),
      title,
      day: v.exactOptional(line('The day written out, such as Friday 3 October.')),
      items: v.pipe(
        v.array(
          v.object({
            at: line('When, as it should read, such as 09:00 or All day.'),
            until: v.exactOptional(line('When it ends, as it should read.')),
            title: line('The event or commitment.'),
            where: v.exactOptional(line('The location.')),
            note: v.exactOptional(words('Useful details for this event.')),
          }),
        ),
        v.minLength(1),
        v.maxLength(30),
        v.description('The day’s events in time order.'),
      ),
    }),
    v.description('Show a day’s events or commitments.'),
  ),
  Form: v.pipe(
    v.object({
      _tag: tag('Form'),
      title: line('The details needed from the Person.'),
      fields: v.pipe(
        v.array(
          v.object({
            label: line('The detail to provide.'),
            kind: v.pipe(
              v.picklist(['text', 'long text', 'number', 'date', 'choice']),
              v.description('The kind of answer needed.'),
            ),
            choices: v.pipe(
              v.array(line('A choice for this field.')),
              v.maxLength(12),
              v.description('Choices for a choice field; empty for other kinds.'),
            ),
            example: v.exactOptional(line('An example shown inside the empty field.')),
          }),
        ),
        v.minLength(1),
        v.maxLength(10),
        v.description('The details needed to continue, at most ten.'),
      ),
      submit: line('Button wording, such as Book it or Save.'),
    }),
    v.description('Collect details from the Person, then wait for their next message.'),
  ),
  Pictures: v.pipe(
    v.object({
      _tag: tag('Pictures'),
      title,
      pictures: v.pipe(
        v.array(
          v.object({
            address: address('The picture address, starting with https://.'),
            caption: v.exactOptional(line('A short caption for the picture.')),
          }),
        ),
        v.minLength(1),
        v.maxLength(12),
        v.description('Pictures to show in order.'),
      ),
    }),
    v.description('Show pictures with optional captions.'),
  ),
} satisfies { [Kind in Shown['_tag']]: v.GenericSchema<unknown, Extract<Shown, { _tag: Kind }>> }

const display = v.variant(
  '_tag',
  Object.values(kinds),
  'Provide show as a JSON object with a valid _tag; do not quote or stringify it.',
)
const request = v.object({ show: display })

/** Name the failed field without echoing the submitted display; one corrected call may succeed. */
function refusal(issues: readonly v.BaseIssue<unknown>[]) {
  const problems = issues.map((issue) => `${v.getDotPath(issue) ?? 'show'}: ${issue.message}`)
  return {
    output: {
      ok: false,
      message: `${problems.join(' ')} Correct these fields and call show again once. Nothing was displayed.`,
    },
    terminate: false,
  }
}

/** The input itself is drawn by every surface; there is no RPC, storage, or second data copy. */
export function showTools() {
  return [
    defineTool({
      name: 'show',
      description:
        'Show a rich result in the Thread. Pass show as a JSON object, never a quoted JSON string. Comparison items require name, good, bad and facts (use [] for empty arrays); short labels are 1–200 characters. If refused, correct the named field and retry once. Options, Form and Draft stop the turn for the Person to answer.',
      input: v.object({
        show: v.pipe(
          // Flue 2.2.2 / pi 0.87.1 checks generated JSON Schema before our Valibot messages.
          // Retain the complete advertised shape, but admit untrusted input to this callback
          // solely for a field-specific refusal. The strict request below still gates every
          // success; clients independently decode ShowRequest before drawing the input.
          v.union([display, v.unknown()]),
          v.description(
            'The complete display object, not serialized JSON text. Invalid input is refused; follow the described shape.',
          ),
        ),
      }),
      /** Only acknowledge the input; repeating it in output would create a second display payload. */
      run({ data }) {
        const parsed = v.safeParse(request, data)
        if (!parsed.success) return refusal(parsed.issues)
        const shown = Shown.match(parsed.output.show, {
          Table: () => 'table',
          Chart: () => 'chart',
          Steps: () => 'steps',
          Options: () => 'options',
          Comparison: () => 'comparison',
          Links: () => 'links',
          Facts: () => 'facts',
          Draft: () => 'draft',
          Schedule: () => 'schedule',
          Form: () => 'form',
          Pictures: () => 'pictures',
        })
        if (Shown.isAnyOf(['Options', 'Form', 'Draft'])(parsed.output.show)) {
          return {
            output: {
              ok: true,
              shown,
              message:
                'The Person will answer in their next message. Stop and wait; do not answer for them.',
            },
            terminate: true,
          }
        }
        return { output: { ok: true, shown }, terminate: false }
      },
    }),
  ] as const
}

/** Teach the model to choose the shape of the answer without inventing content or duplicating it. */
export const instructions =
  'Use show when a display makes the answer clearer: three or more things compared on the same attributes → Comparison or Table; numbers over time or by category → Chart; a plan or progress → Steps; a choice the Person must make → Options; several facts at a glance → Facts; an email or message for them to send → Draft; a day’s events → Schedule; details you need from them → Form; sources → Links. Say one sentence with it, never repeat in prose what the display already shows, and never invent data to fill a display. Do not use show for a single fact or a short answer. Call Options, Form or Draft alone and end your turn; the Person answers in their next message.'

/** Keep instruction composition beside the factory, matching the other tool groups. */
showTools.instructions = instructions
