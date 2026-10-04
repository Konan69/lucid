import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { decisionModelLayer } from './model.ts'
import { Layer, Schema } from 'effect'

/** Live judgments require explicit consent and provider authority; normal suites never spend
 * credentials. The same server composition selects the provider and redacts its key. */
export const liveDecisionEnabled =
  NodeProcess.env['VIVID_LIVE_DECISIONS'] === '1' &&
  (NodeProcess.env['TYPESAFE_API_KEY'] !== undefined ||
    NodeProcess.env['OPENROUTER_API_KEY'] !== undefined)
export const liveDecisionLayer = decisionModelLayer.pipe(Layer.provide(NodeHttpClient.layerUndici))

/** Provider descriptions are fixture inputs only; they never enter production classifiers. */
export const liveTools = [
  {
    serviceName: 'DeepWiki',
    account: 'DeepWiki',
    name: 'ask_question',
    description: 'Ask any question about a GitHub repository',
  },
  {
    serviceName: 'DeepWiki',
    account: 'DeepWiki',
    name: 'read_wiki_structure',
    description: 'Get a list of documentation topics for a GitHub repository',
  },
  {
    serviceName: 'DeepWiki',
    account: 'DeepWiki',
    name: 'read_wiki_contents',
    description: 'View documentation about a GitHub repository',
  },
  {
    serviceName: 'Gmail',
    account: 'Work',
    name: 'send_email',
    description: 'Send an email message to recipients',
  },
  {
    serviceName: 'GitHub',
    account: 'Work',
    name: 'delete_repository',
    description: 'Permanently delete a repository and all of its data',
  },
]

/** Scripted provider wire variants share one vocabulary across behavior tests. The
 * DecisionModel constructor still validates distributions and missing answers. */
export const ScriptedAnswer = Schema.TaggedUnion({
  Probability: { probability: Schema.Number },
  Classify: { label: Schema.String, probabilities: Schema.Record(Schema.String, Schema.Number) },
})
