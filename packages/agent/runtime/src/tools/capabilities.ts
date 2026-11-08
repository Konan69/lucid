import type { ToolRegistration } from '@earendil-works/pi-durable'
import {
  ComputerRecoveryId,
  ComputerRecoveryStep,
  ComputerHealthDepth,
  RecoverComputerRequest,
  CapabilityAvailability as Availability,
  CapabilityReading,
  CapabilityFacts,
  CapabilityComputerFact,
  CapabilityDeviceFact,
  CapabilityIntegrationFact,
  CapabilityFactFailure,
  DeviceAccess,
  DevicePresence,
  Tool,
  ToolName,
  ComputerLifecycle,
  ConnectionState,
} from '@vivid/contracts'
import { Effect, Result, Schema } from 'effect'
import type { Memory } from '../memory.ts'
import type { RunTool, RunScoped, RunMemory } from './scope.ts'
import { Scope } from './scope.ts'
import { defineTool } from './tool.ts'
import * as v from 'valibot'
import { askTools } from './ask.ts'
import { artifactTools } from './artifacts.ts'
import { codeTools } from './code.ts'
import { computerTools } from './computer.ts'
import { connectionTools } from './connections.ts'
import { documentTools } from './documents.ts'
import { libraryTools } from './library.ts'
import { memoryTools, type ProjectOf } from './memory.ts'
import { forgetTools } from './forget.ts'
import { notifyTools } from './notify.ts'
import { feedTools } from './feed.ts'
import { followTools } from './follow.ts'
import { projectTools } from './projects.ts'
import { owedTools } from './owed.ts'
import { todoTools } from './todos.ts'
import { watchTools } from './watches.ts'
import { skillTools } from './skills.ts'

type Requirement = keyof typeof requirements

/** The runtime owns Memory; failed server facts must never hide that local capability. */
export const unknownCapabilityFacts = () =>
  CapabilityFacts.make({
    observedAt: null,
    computer: CapabilityComputerFact.cases.Unavailable.make({
      cause: CapabilityFactFailure.cases.RuntimeUnavailable.make({}),
    }),
    devices: CapabilityDeviceFact.cases.Unavailable.make({
      cause: CapabilityFactFailure.cases.RuntimeUnavailable.make({}),
    }),
    integrations: CapabilityIntegrationFact.cases.Unavailable.make({
      cause: CapabilityFactFailure.cases.RuntimeUnavailable.make({}),
    }),
  })

interface RegistryInput {
  readonly runTool: RunTool
  readonly run: RunScoped
  readonly runMemory: RunMemory
  /** A Project-scoped memory names its Project; the name resolves through the call's own scope. */
  readonly project: ProjectOf
  readonly memory: Memory['Service']
  readonly skills: ReadonlyArray<ToolRegistration>
}
interface MountInput extends RegistryInput {
  readonly connections: ReadonlyArray<ToolRegistration>
  readonly computer: ReadonlyArray<ToolRegistration>
  readonly code: ReadonlyArray<ToolRegistration>
  readonly reading: (facts: CapabilityFacts, memory: boolean) => CapabilityReading
}
const decodeToolNames = Schema.decodeUnknownResult(Schema.Array(ToolName))

/** Each declaration owns its factory, claim and requirements. Names come from its mounted tools. */
const definitions: ReadonlyArray<{
  readonly description: string
  readonly requirement: Requirement
  readonly mount: (input: MountInput) => ReadonlyArray<ToolRegistration>
}> = [
  {
    description:
      'Use a persistent Computer with files, commands, a desktop and browser. Requested work creates or wakes it; a hold or failure can prevent use.',
    requirement: 'Computer',
    mount: ({ computer }) =>
      computer.filter(
        (tool) =>
          ![Tool.use_person_computer, Tool.copy_signin, Tool.browse].some(
            (name) => name === tool.name,
          ),
      ),
  },
  {
    description: 'Browse pages on Vivid’s Computer.',
    requirement: 'Computer',
    mount: ({ computer }) => computer.filter((tool) => tool.name === Tool.browse),
  },
  {
    description:
      'Browse pages on the Person’s allowed, connected desktop. An active Run and the action gate still apply.',
    requirement: 'PersonalPages',
    mount: ({ computer }) => computer.filter((tool) => tool.name === Tool.browse),
  },
  {
    description:
      'Use apps, including terminals, on an allowed, connected Windows desktop with apps support. Stop when the Person stops Vivid.',
    requirement: 'PersonalApps',
    mount: ({ computer }) => computer.filter((tool) => tool.name === Tool.use_person_computer),
  },
  {
    description:
      'Copy a website sign-in from a supported desktop to the Computer after fresh native consent for that site. Copying does not prove login succeeded.',
    requirement: 'SignIn',
    mount: ({ computer }) => computer.filter((tool) => tool.name === Tool.copy_signin),
  },
  {
    description: 'Search documents in the Person’s Library and cite the passages.',
    requirement: 'Product',
    mount: ({ runTool }) => libraryTools(runTool),
  },
  {
    description:
      'Discover Integration tools and services. Use exact discovered account and tool names; discovery does not certify a connection.',
    requirement: 'Integrations',
    mount: ({ connections }) =>
      connections.filter((tool) =>
        [Tool.find_tools, Tool.find_integrations].some((name) => name === tool.name),
      ),
  },
  {
    description:
      'Use and test the Person’s ready Integration accounts. Exact tools are resolved by discovery before each use.',
    requirement: 'ConnectedAccount',
    mount: ({ connections }) =>
      connections.filter((tool) =>
        [Tool.use_tool, Tool.test_integration].some((name) => name === tool.name),
      ),
  },
  {
    description:
      'Connect or create Integrations where operator setup permits it. Discover the exact service before offering a connection.',
    requirement: 'IntegrationSetup',
    mount: ({ connections }) =>
      connections.filter(
        (tool) =>
          ![Tool.find_tools, Tool.find_integrations, Tool.use_tool, Tool.test_integration].some(
            (name) => name === tool.name,
          ),
      ),
  },
  {
    description: 'Ask the Person questions as cards while continuing independent work.',
    requirement: 'Product',
    mount: ({ runTool }) => askTools(runTool),
  },
  {
    description: 'Offer up to three short replies to tap.',
    requirement: 'Local',
    mount: () => followTools(),
  },
  {
    description:
      'Remember, find, correct and forget facts, preferences and decisions in local Memory.',
    requirement: 'Memory',
    mount: ({ runMemory, project }) => memoryTools(runMemory, project),
  },
  {
    description:
      'Plan a forget across every memory entry, Watch and waiting-on record that uses it, then carry it out after one confirmation.',
    requirement: 'Memory',
    mount: ({ runTool }) => forgetTools(runTool),
  },
  {
    description:
      'Notify the Person through the app when something needs attention; delivery depends on their settings and devices.',
    requirement: 'Product',
    mount: ({ runTool }) => notifyTools(runTool),
  },
  {
    description: 'Keep and reuse verified ways of working.',
    requirement: 'Product',
    mount: ({ runTool }) => skillTools(runTool),
  },
  {
    description:
      'Watch Integration events and stop or inspect Watches. Never promise future work without setting it up.',
    requirement: 'Product',
    mount: ({ runTool }) => watchTools(runTool),
  },
  {
    description: 'Put relevant background findings on the Person’s Feed.',
    requirement: 'Product',
    mount: ({ runTool }) => feedTools(runTool),
  },
  {
    description:
      'Create Projects for ongoing groups of work, and keep what done means, where each stands and its next step (read_project, update_project).',
    requirement: 'Product',
    mount: ({ runTool }) => projectTools(runTool),
  },
  {
    description: 'Track, update and resolve what someone owes the Person.',
    requirement: 'Product',
    mount: ({ runTool }) => owedTools(runTool),
  },
  {
    description:
      'Keep the Person’s own to-do list: add what they commit to, tick off only on evidence, drop what they no longer mean to do, and read it with list_todos before saying what is on it.',
    requirement: 'Product',
    mount: ({ runTool }) => todoTools(runTool),
  },
  {
    description: 'Run a JavaScript program on the Computer for multi-step work.',
    requirement: 'Computer',
    mount: ({ code }) => code.filter((tool) => tool.name === Tool.run_code),
  },
  {
    description: 'Read public web pages without waking the Computer.',
    requirement: 'Product',
    mount: ({ code }) => code.filter((tool) => tool.name === Tool.read_page),
  },
  {
    description:
      'Write, revise and read documents kept with the conversation, and show charts, tables, forms and pictures. Live Integration views run on the Computer and may wake it.',
    requirement: 'Product',
    mount: ({ runTool }) => documentTools(runTool),
  },
  {
    description:
      'Make Word, PDF and PNG files on the Computer, inspect a captured render, and deliver their exact bytes with the editable source kept.',
    requirement: 'Computer',
    mount: ({ runTool }) => artifactTools(runTool),
  },
  {
    description: 'Activate built-in skills and read their reference files.',
    requirement: 'Local',
    mount: ({ skills }) => skills,
  },
  {
    description:
      'Read current capabilities and passive Computer health, or request one targeted recovery step. Never replay an interrupted action or automatically climb the recovery ladder.',
    requirement: 'Product',
    mount: inspectionTools,
  },
]

/** Live reference tools use the invocation’s resolved Person and never shared preload facts. */
function inspectionTools(input: MountInput) {
  const { runTool, reading } = input
  return [
    defineTool({
      name: Tool.get_capabilities,
      description:
        'Read fresh scoped capability facts and the actual mounted tool registry before answering what you can do. This never wakes or repairs a Computer.',
      input: v.object({}),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const scope = yield* Scope
            const facts = yield* scope.client.GetCapabilities()
            const memory = yield* input.memory.index(scope.acting.personId).pipe(
              Effect.as(true),
              Effect.catchTag('MemoryUnavailable', () => Effect.succeed(false)),
            )
            return { output: reading(facts, memory) }
          }),
          { signal, tool: 'get_capabilities' },
        )
      },
    }),
    defineTool({
      name: Tool.computer_health,
      description:
        'Read Computer health without waking it or extending its idle deadline. Deep probes run only on an already running, unheld Computer.',
      input: v.object({ depth: v.picklist(ComputerHealthDepth.literals) }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            return { output: yield* (yield* Scope).client.GetComputerHealth(data) }
          }),
          { signal, tool: 'computer_health' },
        )
      },
    }),
    defineTool({
      name: Tool.recover_computer,
      description:
        'Take one explicit targeted Computer recovery step. Reuse the same UUID for a retried request. Never replay an uncertain action. Restore or unattested supervisors return Unsupported.',
      input: v.object({
        id: v.pipe(v.string(), v.uuid()),
        step: v.picklist(ComputerRecoveryStep.literals),
      }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const request = RecoverComputerRequest.make({
              id: ComputerRecoveryId.make(data.id),
              step: data.step,
            })
            return { output: yield* (yield* Scope).client.RecoverComputer(request) }
          }),
          { signal, tool: 'recover_computer' },
        )
      },
    }),
  ]
}

/** Construct once per Person cell, then use exactly these registrations for mounting and claims. */
export function capabilityRegistry(input: RegistryInput) {
  const computer = computerTools(input.runTool, input.run)
  const code = codeTools(input.runTool)
  const connections = connectionTools(input.runTool)
  // An invalid authored name must stop cell startup, rather than vanish from capability truth.
  const named = definitions.map((entry) => {
    const mounted = entry.mount({ ...input, computer, code, connections, reading })
    return {
      description: entry.description,
      requirement: entry.requirement,
      tools: mounted,
      names: Result.getOrThrow(decodeToolNames(mounted.map((tool) => tool.name))),
    }
  })
  function reading(facts: CapabilityFacts, memory: boolean): CapabilityReading {
    return CapabilityReading.make({
      facts,
      abilities: named.map((group) => ({
        description: group.description,
        tools: group.names,
        availability: availability(group.requirement, facts, memory),
      })),
    })
  }
  return {
    tools: [
      ...new Map(
        named
          .flatMap((group) =>
            ['Integrations', 'ConnectedAccount', 'IntegrationSetup'].includes(group.requirement)
              ? connections
              : group.tools,
          )
          .map((tool) => [tool.name, tool]),
      ).values(),
    ].filter((tool) => !input.skills.includes(tool)),
    reading,
  }
}

/** The same registry supplies prompt claims; readiness is frozen separately at admission. */
export function capabilityInstructions(reading: CapabilityReading) {
  return [
    'Your supported abilities and current prerequisites come from the mounted registry below. Saved facts may be stale. Always call get_capabilities before describing what you can do now. Do not claim unavailable abilities as usable now. You cannot make or take calls or control a phone.',
    ...reading.abilities.map(
      (ability) => `${ability.description} Current reading: ${ability.availability._tag}.`,
    ),
  ]
}

/** Personal access, connection and ability are separate facts; cloud capability never substitutes. */
function personal(facts: CapabilityFacts, kind: 'apps' | 'pages' | 'signins'): Availability {
  if (CapabilityDeviceFact.guards.Unavailable(facts.devices))
    return Availability.cases.Unknown.make({})
  const allowed = facts.devices.value.filter((device) => DeviceAccess.guards.Allowed(device.access))
  if (allowed.length === 0) return Availability.cases.NeedsPermission.make({})
  const online = allowed.flatMap((device) =>
    DevicePresence.guards.Connected(device.presence) ? [device.presence.ability] : [],
  )
  if (online.length === 0) return Availability.cases.NeedsConnection.make({})
  return online.some((ability) => ability[kind])
    ? Availability.cases.Available.make({})
    : Availability.cases.Unsupported.make({
        reason: 'The connected desktop does not advertise this ability.',
      })
}
/** Only Computer-backed work wakes on use. Integration discovery remains available while
 * account state is exposed in facts; no registry can certify an external tool before discovery. */
const requirements = {
  Local: () => Availability.cases.Available.make({}),
  Memory: (_facts: CapabilityFacts, memory: boolean) =>
    memory ? Availability.cases.Available.make({}) : Availability.cases.Unknown.make({}),
  PersonalApps: (facts: CapabilityFacts) => personal(facts, 'apps'),
  PersonalPages: (facts: CapabilityFacts) => personal(facts, 'pages'),
  SignIn: signInAvailability,
  Product: (facts: CapabilityFacts) =>
    facts.observedAt === null
      ? Availability.cases.Unknown.make({})
      : Availability.cases.Available.make({}),
  Integrations: (facts: CapabilityFacts) =>
    CapabilityIntegrationFact.guards.Unavailable(facts.integrations)
      ? Availability.cases.Unknown.make({})
      : Availability.cases.Available.make({}),
  ConnectedAccount: connectedAccount,
  IntegrationSetup: (facts: CapabilityFacts) => {
    if (CapabilityIntegrationFact.guards.Unavailable(facts.integrations))
      return Availability.cases.Unknown.make({})
    switch (facts.integrations.value.setup) {
      case 'Available':
        return Availability.cases.Available.make({})
      case 'Unavailable':
        return Availability.cases.Unsupported.make({
          reason: 'Integration operator setup is unavailable.',
        })
      case 'Unknown':
        return Availability.cases.Unknown.make({})
    }
  },
  Computer: computerAvailability,
}

/** The requirement table is exhaustive by construction; adding a requirement changes its type. */
function availability(
  requirement: Requirement,
  facts: CapabilityFacts,
  memory: boolean,
): Availability {
  return requirements[requirement](facts, memory)
}

/** A missing account, lapsed authorization and a failed account imply different remedies. */
function connectedAccount(facts: CapabilityFacts): Availability {
  if (CapabilityIntegrationFact.guards.Unavailable(facts.integrations))
    return Availability.cases.Unknown.make({})
  const accounts = facts.integrations.value.accounts
  if (accounts.length === 0) return Availability.cases.NeedsConnection.make({})
  if (accounts.some((account) => ConnectionState.guards.Ready(account.state)))
    return Availability.cases.Available.make({})
  if (accounts.some((account) => ConnectionState.guards.NeedsAuthorization(account.state)))
    return Availability.cases.NeedsPermission.make({})
  return Availability.cases.TemporarilyUnavailable.make({
    reason: 'No Integration account is ready.',
  })
}

/** Lifecycle availability is shallow. Ready to attempt work does not certify deep component health. */
function computerAvailability(facts: CapabilityFacts): Availability {
  if (CapabilityComputerFact.guards.Unavailable(facts.computer))
    return Availability.cases.Unknown.make({})
  if (facts.computer.value.heldByPerson)
    return Availability.cases.TemporarilyUnavailable.make({
      reason: 'The Person holds the keyboard.',
    })
  return ComputerLifecycle.match<Availability>(facts.computer.value.state, {
    Absent: () => Availability.cases.WakeOnUse.make({}),
    Stopped: () => Availability.cases.WakeOnUse.make({}),
    Running: () => Availability.cases.Available.make({}),
    Starting: () =>
      Availability.cases.TemporarilyUnavailable.make({ reason: 'The Computer is starting.' }),
    Failed: ({ reason }) => Availability.cases.TemporarilyUnavailable.make({ reason }),
  })
}

/** Sign-in transfer needs both machines plus fresh consent for the requested site. */
function signInAvailability(facts: CapabilityFacts): Availability {
  const device = personal(facts, 'signins')
  if (!Availability.guards.Available(device)) return device
  const computer = computerAvailability(facts)
  return Availability.isAnyOf(['Available', 'WakeOnUse'])(computer)
    ? Availability.cases.NeedsPermission.make({})
    : computer
}
