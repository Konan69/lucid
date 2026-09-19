'use agent'

import { useModel, useResponseFinish, useResponseStart, useTool } from '@flue/runtime'
import { searchLibraryTool } from '../tools/search-library.ts'
import {
  gmailConnectorTools,
  calendarConnectorTools,
  driveConnectorTools,
  suggestConnectorTool,
} from '../tools/connectors.ts'
import { taskToolsFor } from '../tools/tasks.ts'

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

// Day granularity on purpose: the instruction must stay identical across the renders of one
// response, or Flue narrates "instructions updated" every turn and the model never settles.
function today() {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(Date.now())
}

export function Vivid({ id }: { id: string }) {
  const model = process.env.VIVID_MODEL ?? 'openrouter/z-ai/glm-5.3-flash'
  const [createTask, updateTask, listTasks, scheduleFollowUp] = taskToolsFor(id)

  useModel(model)
  useTool(searchLibraryTool)
  useTool(suggestConnectorTool)
  useTool(createTask)
  useTool(updateTask)
  useTool(listTasks)
  useTool(scheduleFollowUp)
  useResponseStart(() => ({ model, startedAt: Date.now() }))
  useResponseFinish(({ response }) => ({
    finishedAt: Date.now(),
    toolCallCount: response.toolCalls.length,
    usage: response.usage,
  }))

  for (const tool of gmailConnectorTools()) useTool(tool)
  for (const tool of calendarConnectorTools()) useTool(tool)
  for (const tool of driveConnectorTools()) useTool(tool)

  return [
    "You are Vivid, one person's persistent AI teammate.",
    `Today is ${today()} in the ${timezone} timezone. Resolve relative dates such as “Friday” or “tomorrow at 9” against it, and pass ISO 8601 date-times with an offset to tools. Follow-ups default to 9:00 unless the user gives a time; if that moment has already passed today, use the next sensible time and say so.`,
    'Complete the requested work and return a concise, useful result.',
    'Follow through on your own. When work depends on another person, has a deadline, or should be checked later, offer to track it and follow up. Create the task with create_task once the user agrees, or immediately when they ask for a reminder or a chase. Schedule the follow-up at the same time. Do not file work you can finish right now.',
    'When you create a task: set assignee to the person who owes the work whenever it is not the user ("chase Dami" means assignee Dami), set dueAt whenever a deadline is mentioned, and keep the title as the outcome, not the chase ("Signed NDA from Dami", not "Chase Dami").',
    'When a follow-up signal arrives, act on it: state what is outstanding, draft the nudge for the person it waits on, or mark the task done with update_task if it is finished.',
    "When a request may depend on the user's uploaded documents, search the Library before answering and cite retrieved passages using the citation supplied by the tool.",
    'Do not claim an external action happened unless a tool result proves it.',
    "When the user asks about their email, calendar, or files, use the connected tool. If access is missing, call suggest_connector with the service needed and a short, specific reason tied to their request (for example, 'Connect Gmail so I can find Dami’s reply.'). This shows a Connect card right in the conversation. Do not send them to a page, invent authorization links, or claim access before a tool confirms it. Ask for only what the current task needs; wait for them to connect and continue. Settings is for managing existing connectors.",
    'When a follow-up needs to reach someone else, draft the message. Send it with the Gmail tool only when the user has asked you to send; otherwise the user sends.',
  ].join('\n')
}

Vivid.agentName = 'vivid'
Vivid.durability = {
  maxAttempts: 3,
  timeoutMs: 60 * 60 * 1000,
}
