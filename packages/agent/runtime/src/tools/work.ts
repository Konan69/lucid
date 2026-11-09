import { defineTool } from './tool.ts'
import {
  BackgroundWork,
  Tool,
  WatchPurpose,
  WorkFailure,
  WorkStall,
  WorkStanding,
  WorkStopResult,
  standingOf,
  type WorkNotStopped,
  type WorkStopReport,
} from '@vivid/contracts'
import { Clock, Effect } from 'effect'
import * as v from 'valibot'
import { summary } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import { modelText } from './views.ts'

/**
 * Background work (`apps/server/src/work`): what Vivid has going for the Person besides this
 * reply, and Stop everything. Ported from Grok Bot's CheckSubagent and `StopSubagent {all:true}`
 * (`grok-bot/grok-bot.md:136`, `:137`, `:2507`): a stall is reported as a stall, never as "still
 * working", and a request to stop is answered by stopping everything first, in one call, then
 * saying plainly what may still be running. The model sees names and words, never an id.
 */

/** Why a piece is stalled or failing, as the model says it to the Person. */
const troubleWords = (standing: WorkStanding, now: number) =>
  WorkStanding.match(standing, {
    Going: () => 'going',
    Stalled: ({ stall }) =>
      WorkStall.match(stall, {
        WorkingLong: ({ since }) =>
          `stalled: no answer after ${Math.round((now - since) / 60_000)} minutes`,
        Quiet: ({ since }) =>
          `stalled: it has printed nothing new for ${Math.round((now - since) / 60_000)} minutes`,
        Paused: () => 'stalled: paused until the Person signs in to its Integration again',
        NotConfirmed: () => 'stalled: its Integration has not confirmed the Watch',
        NotRenewed: () =>
          'stalled: its subscription ran out and has not been renewed, so events may be missed',
      }),
    Failing: ({ failure }) =>
      WorkFailure.match(failure, {
        LastRunFailed: ({ reason }) =>
          `failing: the last time it fired, the reply failed (${reason})`,
        IntegrationNeedsSignIn: () => 'failing: its Integration needs the Person to sign in again',
        IntegrationFailed: ({ reason }) => `failing: its Integration failed: ${modelText(reason)}`,
        ComputerUnreachable: ({ since, reason }) =>
          `failing: your Computer has not answered for ${Math.round((now - since) / 60_000)} minutes (${modelText(reason)}), so it may or may not still be running`,
      }),
  })

/** One piece as the model reads it: what kind, its name, why it is there, where it stands. */
const view = (work: BackgroundWork, now: number) => ({
  ...BackgroundWork.match(work, {
    Run: ({ title }) => ({ kind: 'reply still working', name: modelText(title) }),
    Helper: ({ number, brief, title }) => ({
      kind: `helper ${number}`,
      name: modelText(brief),
      for: modelText(title),
    }),
    Command: ({ command, title }) => ({
      kind: 'command running on your Computer',
      name: modelText(command),
      for: modelText(title),
    }),
    Watch: ({ name, account, purpose }) => ({
      kind: WatchPurpose.guards.Checkin(purpose) ? 'check-in' : 'watch',
      name: modelText(name),
      account: modelText(account),
    }),
    MadeIntegration: ({ account, watches }) => ({
      kind: 'Integration you made',
      name: modelText(account),
      watches,
    }),
  }),
  standing: troubleWords(standingOf(work, now), now),
})

/** Why a Stop did not take, in words. */
const NOT_STOPPED = {
  RuntimeUnreachable: 'marked stopped, but the runtime did not answer, so it may still be working',
  IntegrationsUnreachable: 'could not be removed right now',
  ComputerUnreachable: 'your Computer could not be reached to stop it, so it may still be running',
  StillRunning: 'your Computer was told to stop it, but it was still running thirty seconds later',
} satisfies Record<WorkNotStopped, string>

/** What one Stop did, in words. */
const resultWords = (report: WorkStopReport) =>
  WorkStopResult.match(report.result, {
    Stopped: () => 'stopped',
    AlreadyEnded: () => 'had already finished',
    NotStopped: ({ reason }) => NOT_STOPPED[reason],
  })

export function workTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.list_work,
      description:
        'List everything you have going for the Person besides this reply: replies still working, commands still running in the background on your Computer, Watches and Integrations you made, each with whether it is going, stalled or failing and why. Read it when asked what you are doing in the background, and before saying something is still working. Report a stall as a stall.',
      input: v.object({ summary }),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.ListWork()
            const now = yield* Clock.currentTimeMillis
            return { output: { work: response.work.map((one) => view(one, now)) } }
          }),
          { signal, tool: 'list_work' },
        )
      },
    }),
    defineTool({
      name: Tool.stop_all_work,
      description:
        'Stop everything you have going in the background for the Person, in one call: every Watch, every background command on your Computer and every other reply still working, never this one. It deletes nothing. When the Person asks you to stop, halt, cancel or quit what you are doing, in any words, call it first, before checking anything one by one. Then tell them what stopped, what had already finished, and plainly what may still be running. Do not restart, resume or redo the stopped work.',
      input: v.object({ summary }),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.StopAllWork()
            const now = yield* Clock.currentTimeMillis
            return {
              output: {
                stopped: response.stopped.map((report) => ({
                  work: view(report.work, now),
                  result: resultWords(report),
                })),
              },
            }
          }),
          { signal, tool: 'stop_all_work' },
        )
      },
    }),
  ] as const
}
