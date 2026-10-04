import { expect, it } from '@effect/vitest'
import { ActionEffect, ActionTarget, CodeCallKind } from '@vivid/contracts'
import { Struct } from 'effect'
import { Refusal, refusalExport } from './refusal.ts'

it('exports a refusal field only when its schema is a closed set, with that set', () => {
  const exported = new Map(refusalExport)
  expect(exported.get('vivid.refusal.kind')).toEqual(Struct.keys(Refusal.cases))
  expect(exported.get('vivid.refusal.effect')).toEqual(ActionEffect.literals)
  expect(exported.get('vivid.refusal.target')).toEqual(Struct.keys(ActionTarget.cases))
  expect(exported.get('vivid.refusal.call')).toEqual(CodeCallKind.literals)
  // `reason` is a field of four cases; it takes the words of all of them and no others.
  const reasons = [
    Refusal.cases.ToolRejected,
    Refusal.cases.PageRefused,
    Refusal.cases.DeviceRefused,
    Refusal.cases.AdmissionRefused,
  ].flatMap((refusal) => refusal.fields.reason.literals)
  expect(exported.get('vivid.refusal.reason')).toEqual([...new Set(reasons)])
  // `service` is a `ServiceId`, an open string: it has no set, so it is not exported at all.
  expect([...exported.keys()].toSorted()).toEqual([
    'vivid.refusal.call',
    'vivid.refusal.effect',
    'vivid.refusal.kind',
    'vivid.refusal.reason',
    'vivid.refusal.target',
  ])
})
