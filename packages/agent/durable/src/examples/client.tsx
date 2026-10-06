import { useChat } from '@ai-sdk/react'
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai'

/** The text a person typed into the form's field `name`. */
function typed(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name)
  return field instanceof HTMLInputElement ? field.value : ''
}

/**
 * The client side of the server examples: a stock `useChat` component. Nothing here imports this
 * library; the server speaks the AI SDK's own chat protocol.
 *
 * `messages` is the transcript the page loaded from the `history` route. `resume` makes the hook
 * reconnect on mount to a run that is still in progress or waits for a person.
 */
export function Thread(props: { readonly api: string; readonly messages: UIMessage[] }) {
  const chat = useChat({
    transport: new DefaultChatTransport({ api: props.api }),
    messages: props.messages,
    resume: true,
    // Send the approvals and answers back as soon as the person has given all of them.
    sendAutomaticallyWhen: (state) =>
      lastAssistantMessageIsCompleteWithApprovalResponses(state) ||
      lastAssistantMessageIsCompleteWithToolCalls(state),
  })

  /** A tool part by its state: a question to approve, a question to answer, or a plain record. */
  function tool(part: ToolUIPart | DynamicToolUIPart) {
    if (part.state === 'approval-requested') {
      // The approval id is on the part. It names this one waiting call and no later one.
      const decide = (approved: boolean) =>
        chat.addToolApprovalResponse({ id: part.approval.id, approved })
      return (
        <p key={part.toolCallId}>
          Allow {part.type}?{' '}
          <button
            type="button"
            onClick={() => {
              void decide(true)
            }}
          >
            Allow
          </button>{' '}
          <button
            type="button"
            onClick={() => {
              void decide(false)
            }}
          >
            Deny
          </button>
        </p>
      )
    }
    if (part.state === 'input-available' && part.type === 'tool-ask') {
      // A tool with no `execute` on the server: the person's answer is its result.
      return (
        <form
          key={part.toolCallId}
          onSubmit={(event) => {
            event.preventDefault()
            void chat.addToolOutput({
              tool: 'ask',
              toolCallId: part.toolCallId,
              output: typed(event.currentTarget, 'answer'),
            })
          }}
        >
          <input name="answer" aria-label="Your answer" />
          <button type="submit">Answer</button>
        </form>
      )
    }
    return (
      <p key={part.toolCallId}>
        {part.type}: {part.state}
      </p>
    )
  }

  return (
    <section>
      {chat.messages.map((message) => (
        <article key={message.id}>
          <h3>{message.role}</h3>
          <p>
            {message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')}
          </p>
          {message.parts.filter(isToolUIPart).map(tool)}
        </article>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void chat.sendMessage({ text: typed(event.currentTarget, 'text') })
          event.currentTarget.reset()
        }}
      >
        <input name="text" aria-label="Message" />
        <button type="submit" disabled={chat.status !== 'ready'}>
          Send
        </button>
      </form>
    </section>
  )
}
