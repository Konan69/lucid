import * as NodeFS from 'node:fs'

/** Vitest's public reported-task API preserves names, locations and assertion stacks. */
export default class ProofReporter {
  /** Keep parameterized rows separate so one failing input cannot stand for its siblings. */
  onTestRunEnd(modules, unhandled) {
    const tests = modules.flatMap((module) =>
      [...module.children.allTests()].map((test) => {
        const result = test.result()
        return {
          file: module.moduleId,
          name: test.fullName,
          project: test.project.name,
          line: test.location === undefined ? 0 : test.location.line,
          column: test.location === undefined ? 0 : test.location.column,
          state: result.state,
          errors:
            result.errors === undefined
              ? []
              : result.errors.map((error) => ({ name: error.name, stack: error.stack })),
        }
      }),
    )
    NodeFS.writeFileSync(
      process.env.VIVID_PROOF_REPORT,
      JSON.stringify({ tests, unhandled: unhandled.length }),
    )
  }
}
