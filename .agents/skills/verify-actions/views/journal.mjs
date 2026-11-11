/**
 * The `/statechart` view of `models/journal.tla`: one region per operation of the act (two
 * calls of the Run and one Approval), each labelled with its journal row as a Person reads it.
 */
export const title = 'One act, its journal rows and what Executor did'

/** A row's state in words: missing, being sent, settled, reconciled, at Executor, took effect. */
const label = (row, ran, flying) => {
  if (row.st === 'none') return 'no row'
  const reconciled =
    row.rec === 'notapplied' ? ', proven not applied' : row.rec === 'applied' ? ', proven applied' : ''
  const phase = row.st === 'dispatching' ? 'being sent' : row.st
  return `${phase}${reconciled}${flying ? ', still at Executor' : ''}${ran ? ', took effect' : ''}`
}

export const state = (vars) => {
  const landed = Object.values(vars.landed).map((entry) => entry.op)
  const region = (op) => label(vars.row[op], landed.includes(op), vars.inflight.includes(op))
  return { 'Run call 1': region('c1'), 'Run call 2': region('c2'), Approval: region('ap') }
}

const steps = {
  Start: 'the Run calls the tool, or the Person allows the Approval',
  Before: 'the journal is checked before the Gate',
  Claim: 'the send is claimed',
  Send: 'the request reaches Executor',
  Execute: 'Executor finishes the request',
  Read: 'Vivid reads the answer',
  Timeout: 'Vivid stops waiting after 90 s',
  Reconcile: 'the provider lookup answers',
  Resume: 'the Person answers the pause',
  PauseExpires: 'the pause runs out',
  Crash: 'the server restarts',
}

export const step = (action) => steps[action] ?? action
