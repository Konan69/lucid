import * as NodeEvents from 'node:events'
import { visitorKeys } from 'oxc-parser'
import { noCrossPackageImport } from './boundary.mjs'

// Each runner has a `With` form that takes a Context first (`Effect.runPromiseWith(context)(program)`).
// It starts an Effect exactly as the plain form does, so every rule about runners covers both.
const effectTerminalOperations = new Set([
  'runCallback',
  'runCallbackWith',
  'runFork',
  'runForkWith',
  'runPromise',
  'runPromiseExit',
  'runPromiseExitWith',
  'runPromiseWith',
  'runSync',
  'runSyncExit',
  'runSyncExitWith',
  'runSyncWith',
])
const schemaClassFactories = new Set(['Class', 'TaggedClass', 'TaggedError'])
// These Schema APIs compile reusable functions; rebuilding them on each call adds avoidable work.
const schemaCompilerMethods = new Set([
  'is',
  'asserts',
  'decodeEffect',
  'decodeExit',
  'decodeOption',
  'decodePromise',
  'decodeResult',
  'decodeSync',
  'decodeUnknownEffect',
  'decodeUnknownExit',
  'decodeUnknownOption',
  'decodeUnknownPromise',
  'decodeUnknownResult',
  'decodeUnknownSync',
  'encodeEffect',
  'encodeExit',
  'encodeOption',
  'encodePromise',
  'encodeResult',
  'encodeSync',
  'encodeUnknownEffect',
  'encodeUnknownExit',
  'encodeUnknownOption',
  'encodeUnknownPromise',
  'encodeUnknownResult',
  'encodeUnknownSync',
])
const manualEffectRuntimeMethods = new Set([
  'runFork',
  'runForkWith',
  'runPromise',
  'runPromiseWith',
  'runSync',
  'runSyncWith',
])
const nodeModuleAliases = new Map([
  ['assert/strict', 'Assert'],
  ['fs/promises', 'FSP'],
])
const nodeSegmentAliases = new Map([
  ['fs', 'FS'],
  ['os', 'OS'],
  ['url', 'URL'],
  ['vm', 'VM'],
])
const processRuntimeProperties = new Set(['arch', 'platform'])
const nodeOsModules = new Set(['node:os', 'os'])
const syncCallbackMethods = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'sort',
])

const propertyName = (node) => {
  if (node?.type !== 'MemberExpression') return undefined
  if (node.computed) {
    return node.property?.type === 'Literal' && typeof node.property.value === 'string'
      ? node.property.value
      : undefined
  }
  return node.property?.type === 'Identifier' ? node.property.name : undefined
}

const isMember = (node, owner, names) =>
  node?.type === 'MemberExpression' &&
  node.object?.type === 'Identifier' &&
  node.object.name === owner &&
  names.has(propertyName(node))

const isMemberCall = (node, owner, names) =>
  node?.type === 'CallExpression' && isMember(node.callee, owner, names)

const isFunction = (node) =>
  node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'

const isStringLiteral = (node) =>
  (node?.type === 'Literal' || node?.type === 'StringLiteral') && typeof node.value === 'string'

// Oxlint exposes TypeScript and parenthesized wrappers around the expression a rule needs to inspect.
const unwrapExpression = (node) => {
  let current = node
  while (
    current?.type === 'ChainExpression' ||
    current?.type === 'ParenthesizedExpression' ||
    current?.type === 'TSNonNullExpression' ||
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSTypeAssertion'
  ) {
    current = current.expression
  }
  return current
}

const toPascalCase = (value) =>
  value
    .split(/[_-]/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join('')

const expectedNodeNamespace = (source) => {
  const moduleName = source.slice('node:'.length)
  const knownAlias = nodeModuleAliases.get(moduleName)
  if (knownAlias !== undefined) return `Node${knownAlias}`
  return `Node${moduleName
    .split('/')
    .map((segment) => nodeSegmentAliases.get(segment) ?? toPascalCase(segment))
    .join('')}`
}

const objectProperty = (node, name) =>
  node?.type === 'ObjectExpression'
    ? node.properties.find(
        (property) =>
          property.type === 'Property' &&
          ((property.key?.type === 'Identifier' && property.key.name === name) ||
            (isStringLiteral(property.key) && property.key.value === name)),
      )
    : undefined

const sourceText = (context, node) => context.sourceCode.getText(node)

const rule = (description, message, visitors) => ({
  meta: {
    type: 'problem',
    docs: { description },
    schema: [],
    messages: { forbidden: message },
  },
  create(context) {
    const report = (node, data) => context.report({ node, messageId: 'forbidden', data })
    return visitors(report, context)
  },
})

const memberCallRule = ({ description, message, owner, methods }) =>
  rule(description, message, (report) => ({
    CallExpression(node) {
      if (isMemberCall(node, owner, methods)) report(node)
    },
  }))

const noTryCatch = rule(
  'Keep expected application failures in the typed Effect error channel.',
  'Do not use catch for expected failures in app/domain code. Use typed Effect failures and recover at the owning boundary.',
  (report) => ({
    TryStatement(node) {
      if (node.handler !== null) report(node.handler)
    },
  }),
)

const noNonNullAssertion = rule(
  'Require evidence rather than TypeScript non-null assertions.',
  'Do not use a non-null assertion. Parse, narrow, or model the missing case explicitly.',
  (report) => ({
    TSNonNullExpression: report,
  }),
)

const noOptionalChaining = rule(
  'Keep optional state explicit instead of walking uncertain shapes.',
  'Do not use optional chaining in domain/application code. Model the state with Option or a tagged variant and branch once.',
  (report) => ({
    ChainExpression: report,
  }),
)

const noUndefinedInUnion = rule(
  'Use optional fields, Option, or tagged variants instead of explicit undefined unions.',
  'Do not add undefined to a union. Use an optional field, Option, or a tagged state.',
  (report) => ({
    TSUnionType(node) {
      if (node.types.some((type) => type.type === 'TSUndefinedKeyword')) report(node)
    },
  }),
)

const noDirectProcessEnv = rule(
  'Read process configuration through Effect Config.',
  'Do not read process.env directly in production code. Decode configuration once through Effect Config.',
  (report, context) => {
    const firstStatement = context.sourceCode.ast.body[0]
    const isAgentModule =
      firstStatement?.type === 'ExpressionStatement' && firstStatement.directive === 'use agent'
    return {
      MemberExpression(node) {
        if (
          !isAgentModule &&
          node.object?.type === 'MemberExpression' &&
          node.object.object?.type === 'Identifier' &&
          node.object.object.name === 'process' &&
          propertyName(node.object) === 'env'
        ) {
          report(node)
        }
      },
    }
  },
)

const noRuntimeEnvMutation = rule(
  'Keep environment input immutable after process startup.',
  'Do not mutate process.env at runtime. Supply explicit configuration to the process or a test Layer.',
  (report) => ({
    AssignmentExpression(node) {
      const target = node.left
      if (
        target?.type === 'MemberExpression' &&
        target.object?.type === 'MemberExpression' &&
        target.object.object?.type === 'Identifier' &&
        target.object.object.name === 'process' &&
        propertyName(target.object) === 'env'
      ) {
        report(node)
      }
    },
  }),
)

const isGlobalProcessObject = (node) => {
  const expression = unwrapExpression(node)
  if (expression?.type === 'Identifier' && expression.name === 'process') return true
  return (
    expression?.type === 'MemberExpression' &&
    unwrapExpression(expression.object)?.type === 'Identifier' &&
    unwrapExpression(expression.object).name === 'globalThis' &&
    propertyName(expression) === 'process'
  )
}

const processRuntimeMessage = (property) =>
  `Do not read process.${property} directly. Inject the host runtime ${property} at the adapter boundary and provide it explicitly in tests.`

// Ambient platform checks hide a runtime dependency and make cross-platform behavior hard to test.
const noGlobalProcessRuntime = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow ambient host platform and architecture reads.',
    },
    schema: [],
  },
  create(context) {
    const nodeOsNamespaces = new Set()
    const nodeOsRuntimeImports = new Map()

    return {
      ImportDeclaration(node) {
        if (!isStringLiteral(node.source) || !nodeOsModules.has(node.source.value)) return
        for (const specifier of node.specifiers) {
          const localName = specifier.local?.name
          if (typeof localName !== 'string') continue
          if (
            specifier.type === 'ImportNamespaceSpecifier' ||
            specifier.type === 'ImportDefaultSpecifier'
          ) {
            nodeOsNamespaces.add(localName)
            continue
          }
          const imported = specifier.imported?.name ?? specifier.imported?.value
          if (processRuntimeProperties.has(imported)) nodeOsRuntimeImports.set(localName, imported)
        }
      },
      MemberExpression(node) {
        const property = propertyName(node)
        if (processRuntimeProperties.has(property) && isGlobalProcessObject(node.object)) {
          context.report({ node, message: processRuntimeMessage(property) })
        }
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee)
        let property
        if (callee?.type === 'Identifier') {
          property = nodeOsRuntimeImports.get(callee.name)
        } else if (
          callee?.type === 'MemberExpression' &&
          unwrapExpression(callee.object)?.type === 'Identifier' &&
          nodeOsNamespaces.has(unwrapExpression(callee.object).name)
        ) {
          property = propertyName(callee)
        }
        if (processRuntimeProperties.has(property)) {
          context.report({ node, message: processRuntimeMessage(property) })
        }
      },
    }
  },
}

const noPromiseConstructor = rule(
  'Use Effect async adapters instead of constructing raw Promises.',
  'Do not construct Promise in application code. Wrap the external callback boundary with Effect.async or Effect.tryPromise.',
  (report) => ({
    NewExpression(node) {
      if (node.callee?.type === 'Identifier' && node.callee.name === 'Promise') report(node)
    },
  }),
)

const noRunPromiseNested = rule(
  'Keep Effect execution at one runtime boundary.',
  'Do not execute Effect from inside an Effect callback. Yield or compose the nested Effect instead.',
  (report) => ({
    CallExpression(node) {
      if (!isMemberCall(node, 'Effect', effectTerminalOperations)) return
      let parent = node.parent
      while (parent !== undefined && parent !== null) {
        if (isMemberCall(parent, 'Effect', new Set(['gen', 'fn', 'fnUntraced']))) {
          report(node)
          return
        }
        parent = parent.parent
      }
    },
  }),
)

const noRunPromiseInLibrary = rule(
  'Execute Effect only at an application entry point.',
  'Do not call an Effect runtime terminal in a reusable module. Return the Effect and run it from the owning entry point.',
  (report, context) => ({
    CallExpression(node) {
      if (!isMemberCall(node, 'Effect', effectTerminalOperations)) return
      if (
        /(?:^|[/\\])(?:(?:main|server|cli|app)\.[cm]?[jt]s|drizzle\.config\.ts|alchemy\.run\.ts)$/u.test(
          context.filename,
        )
      )
        return
      let parent = node.parent
      while (parent !== undefined && parent !== null) {
        if (
          parent.type === 'Property' &&
          ((parent.key?.type === 'Identifier' && parent.key.name === 'run') ||
            (parent.key?.type === 'Literal' && parent.key.value === 'run')) &&
          parent.parent?.type === 'ObjectExpression' &&
          parent.parent.parent?.type === 'CallExpression' &&
          parent.parent.parent.callee?.type === 'Identifier' &&
          parent.parent.parent.callee.name === 'defineTool'
        )
          return
        parent = parent.parent
      }
      report(node)
    },
  }),
)

const noPlatformRuntimeRunMainInLibrary = rule(
  'Keep platform runtime launch at the executable entry point.',
  'Do not call NodeRuntime.runMain from a library module. Export the Effect and launch it from main.ts.',
  (report, context) => ({
    CallExpression(node) {
      if (!isMemberCall(node, 'NodeRuntime', new Set(['runMain']))) return
      if (/(?:^|[/\\])main\.[cm]?[jt]s$/u.test(context.filename)) return
      report(node)
    },
  }),
)

const noEffectRuntimeApi = memberCallRule({
  description: 'Avoid creating hidden Effect runtimes in application modules.',
  message:
    'Do not create or execute a private Effect Runtime here. Use the application Layer graph and its single runtime boundary.',
  owner: 'Runtime',
  methods: new Set(['defaultRuntime', 'make', 'runCallback', 'runFork', 'runPromise', 'runSync']),
})

const noUnnecessaryDie = memberCallRule({
  description: 'Preserve expected failures in the typed error channel.',
  message:
    'Do not terminate an expected failure with orDie/orDieWith. Keep it typed until the owning boundary.',
  owner: 'Effect',
  methods: new Set(['orDie', 'orDieWith']),
})

const noEffectCatchRawError = rule(
  'Require schema-backed expected errors in Effect recovery.',
  'Do not construct or fail with a raw Error inside Effect recovery. Return a schema-backed tagged error.',
  (report, context) => ({
    CallExpression(node) {
      if (!isMemberCall(node, 'Effect', new Set(['catch', 'catchAll', 'catchTag', 'catchTags'])))
        return
      const callback = node.arguments.at(-1)
      if (!isFunction(callback)) return
      if (sourceText(context, callback).includes('new Error(')) report(callback)
    },
  }),
)

const noEffectOptionConstructors = memberCallRule({
  description: 'Construct optional values with the Option module.',
  message: 'Use Option.some/Option.none for optional values; Effect is for computations.',
  owner: 'Effect',
  methods: new Set(['none', 'some']),
})

const noDirectSchemaSafeParse = rule(
  'Decode Effect Schema through its explicit typed adapters.',
  'Do not invent a safeParse facade over Effect Schema. Use Schema.decodeUnknownEffect/Option/Either at the boundary.',
  (report) => ({
    CallExpression(node) {
      if (node.callee?.type !== 'MemberExpression' || propertyName(node.callee) !== 'safeParse')
        return
      const owner = node.callee.object
      if (owner?.type === 'Identifier' && /Schema$/u.test(owner.name)) report(node)
    },
  }),
)

const isStaticSchemaReference = (node) => {
  const expression = unwrapExpression(node)
  if (expression?.type === 'Identifier') {
    const firstCharacter = expression.name[0]
    return firstCharacter !== undefined && firstCharacter.toUpperCase() === firstCharacter
  }
  return expression?.type === 'MemberExpression'
}

const isNestedStaticSchemaCall = (node) => {
  const expression = unwrapExpression(node)
  if (expression?.type !== 'CallExpression') return false
  const callee = unwrapExpression(expression.callee)
  if (
    callee?.type !== 'MemberExpression' ||
    unwrapExpression(callee.object)?.type !== 'Identifier' ||
    unwrapExpression(callee.object).name !== 'Schema'
  ) {
    return false
  }
  if (propertyName(callee) === 'fromJsonString') {
    return (
      isStaticSchemaReference(expression.arguments[0]) ||
      isNestedStaticSchemaCall(expression.arguments[0])
    )
  }
  return true
}

const isImmediatelyInvoked = (node) => {
  const expression = unwrapExpression(node)
  const parent = unwrapExpression(expression?.parent)
  return parent?.type === 'CallExpression' && unwrapExpression(parent.callee) === expression
}

// Static schema references can be compiled once at module scope; dynamic schema factories remain valid.
const noInlineSchemaCompile = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Hoist Effect Schema compiler calls out of function bodies.',
    },
    schema: [],
  },
  createOnce(context) {
    let functionDepth = 0
    return {
      before() {
        functionDepth = 0
      },
      FunctionDeclaration() {
        functionDepth += 1
      },
      'FunctionDeclaration:exit'() {
        functionDepth -= 1
      },
      FunctionExpression() {
        functionDepth += 1
      },
      'FunctionExpression:exit'() {
        functionDepth -= 1
      },
      ArrowFunctionExpression() {
        functionDepth += 1
      },
      'ArrowFunctionExpression:exit'() {
        functionDepth -= 1
      },
      CallExpression(node) {
        if (functionDepth === 0 || !isImmediatelyInvoked(node)) return
        const callee = unwrapExpression(node.callee)
        if (
          callee?.type !== 'MemberExpression' ||
          unwrapExpression(callee.object)?.type !== 'Identifier' ||
          unwrapExpression(callee.object).name !== 'Schema'
        ) {
          return
        }
        const method = propertyName(callee)
        if (!schemaCompilerMethods.has(method)) return
        const schema = node.arguments[0]
        const highConfidence = schema !== undefined && isNestedStaticSchemaCall(schema)
        if (!highConfidence && !isStaticSchemaReference(schema)) return
        const message = highConfidence
          ? `Hoist Schema.${method}(...) to module scope: both the inline schema literal and the compiled function are rebuilt on every call. Move the compiled function to a module-level const.`
          : `Hoist Schema.${method}(...) to module scope: the compiled function is rebuilt on every call. Move it to a module-level const.`
        context.report({ node: node.callee, message })
      },
    }
  },
}

// Vivid still has node:test integration adapters, so enforce Effect-native execution only after a file opts into Vitest.
const noManualEffectRuntimeInTests = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Use @effect/vitest instead of manually running Effect programs in Vitest files.',
    },
    schema: [],
  },
  create(context) {
    let importsVitest = false
    return {
      Program(node) {
        importsVitest = node.body.some(
          (statement) =>
            statement.type === 'ImportDeclaration' &&
            isStringLiteral(statement.source) &&
            (statement.source.value === 'vitest' || statement.source.value === '@effect/vitest'),
        )
      },
      CallExpression(node) {
        if (!importsVitest || !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(context.filename)) return
        if (!isMemberCall(node, 'Effect', manualEffectRuntimeMethods)) return
        const method = propertyName(node.callee)
        context.report({
          node: node.callee,
          message: `Do not use Effect.${method} in Vitest tests. Use @effect/vitest it.effect(...) with test layers instead.`,
        })
      },
    }
  },
}

// Native ESM exports snapshot values; inherited event methods and live process state need default.
const processObjectMembers = new Set([
  ...Object.getOwnPropertyNames(NodeEvents.EventEmitter.prototype).filter(
    (name) =>
      name !== 'constructor' && typeof NodeEvents.EventEmitter.prototype[name] === 'function',
  ),
  'ppid',
  'exitCode',
  'connected',
  'channel',
  'title',
  'debugPort',
])

/** Follow the actual import binding so a same-named parameter never inherits this restriction. */
const reportProcessNamespaceAccess = (context, declaration) => {
  for (const variable of context.sourceCode.getDeclaredVariables(declaration)) {
    for (const reference of variable.references) {
      const identifier = reference.identifier
      const access = identifier.parent
      if (
        access?.type === 'MemberExpression' &&
        access.object === identifier &&
        processObjectMembers.has(propertyName(access))
      ) {
        context.report({
          node: access,
          message: `Use the default NodeProcess import for ${propertyName(access)}; the native ESM namespace lacks inherited event methods and snapshots live process state.`,
        })
      }
    }
  }
}

// Keep built-ins obvious; node:process additionally needs its real object for methods/live state.
const namespaceNodeImports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require canonical Node imports and the process object for methods/live state.',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!isStringLiteral(node.source) || !node.source.value.startsWith('node:')) return
        const expectedAlias = expectedNodeNamespace(node.source.value)
        // Node's ESM namespace contains named exports only. The default is the process instance,
        // whose inherited once/on/off methods are absent from that namespace (Node v24.14.1
        // doc/api/esm.md, Built-in modules). Forcing a namespace breaks native child entry points.
        const processObject =
          node.source.value === 'node:process' &&
          node.specifiers.length === 1 &&
          node.specifiers[0]?.type === 'ImportDefaultSpecifier' &&
          node.specifiers[0].local.name === expectedAlias
        if (processObject) return
        const namespaceImport =
          node.specifiers.length === 1 && node.specifiers[0]?.type === 'ImportNamespaceSpecifier'
            ? node.specifiers[0]
            : undefined
        if (namespaceImport !== undefined && node.source.value === 'node:process')
          reportProcessNamespaceAccess(context, node)
        if (namespaceImport?.local?.name === expectedAlias) return
        context.report({
          node,
          message:
            node.source.value === 'node:process'
              ? `Import node:process as ${expectedAlias}; use its default object for event methods and live state.`
              : `Import ${node.source.value} as a namespace named ${expectedAlias}.`,
        })
      },
    }
  },
}

const noParseMethodAlias = rule(
  'Keep schema decode operations explicit at their call sites.',
  'Do not alias a parse/decode method. Call the named Schema adapter through its owner so the boundary remains visible.',
  (report) => ({
    VariableDeclarator(node) {
      if (node.id?.type !== 'ObjectPattern') return
      if (
        node.id.properties.some(
          (property) =>
            property.type === 'Property' &&
            ['parse', 'safeParse', 'decode', 'decodeUnknown'].includes(
              property.key?.type === 'Identifier' ? property.key.name : property.key?.value,
            ),
        )
      ) {
        report(node)
      }
    },
  }),
)

const schemaFactoryCall = (node) => {
  let current = node
  while (current?.type === 'CallExpression' || current?.type === 'MemberExpression') {
    if (
      current.type === 'CallExpression' &&
      current.callee?.type === 'MemberExpression' &&
      isMember(current.callee, 'Schema', schemaClassFactories)
    ) {
      return current
    }
    current = current.type === 'CallExpression' ? current.callee : current.object
  }
  return undefined
}

const hasSchemaIdentifier = (node) => {
  let current = node
  while (current?.type === 'CallExpression' || current?.type === 'MemberExpression') {
    if (current.type === 'CallExpression' && current.arguments.some(isStringLiteral)) return true
    current = current.type === 'CallExpression' ? current.callee : current.object
  }
  return false
}

const hasSchemaTitle = (node) => {
  let current = node
  while (current?.type === 'CallExpression' || current?.type === 'MemberExpression') {
    if (current.type === 'CallExpression') {
      const annotationCall =
        current.callee?.type === 'MemberExpression' &&
        new Set(['annotate', 'annotations']).has(propertyName(current.callee))
      if (annotationCall && objectProperty(current.arguments[0], 'title') !== undefined) return true
      if (current.arguments.some((argument) => objectProperty(argument, 'title') !== undefined))
        return true
    }
    current = current.type === 'CallExpression' ? current.callee : current.object
  }
  return false
}

const requireSchemaClassIdentifier = rule(
  'Give each Effect Schema class a stable runtime identifier.',
  'Schema classes require a stable string identifier so diagnostics and encoded contracts remain traceable.',
  (report) => ({
    ClassDeclaration(node) {
      if (
        schemaFactoryCall(node.superClass) !== undefined &&
        !hasSchemaIdentifier(node.superClass)
      ) {
        report(node.superClass)
      }
    },
  }),
)

const requireSchemaClassTitle = rule(
  'Give each Effect Schema class human-readable title metadata.',
  'Schema classes require annotations({ title: ... }) metadata for generated documentation and diagnostics.',
  (report) => ({
    ClassDeclaration(node) {
      if (schemaFactoryCall(node.superClass) !== undefined && !hasSchemaTitle(node.superClass)) {
        report(node.superClass)
      }
    },
  }),
)

const requireSchemaDecodeInBoundary = rule(
  'Validate host JSON transformations at their ingress boundary.',
  'Do not consume JSON.parse output as a domain value. Decode it immediately with a named Effect Schema.',
  (report) => ({
    CallExpression(node) {
      if (isMemberCall(node, 'JSON', new Set(['parse']))) report(node)
    },
  }),
)

const requireNamedEffectFn = rule(
  'Name reusable Effect programs for traces and diagnostics.',
  'Reusable Effect.gen programs must be wrapped in a named Effect.fn.',
  (report) => ({
    VariableDeclarator(node) {
      if (isMemberCall(node.init, 'Effect', new Set(['gen']))) report(node.init)
    },
  }),
)

const effectPreferMatchEffect = rule(
  'Use one exhaustive combinator when both Effect branches are transformed.',
  'Prefer Effect.matchEffect when code immediately handles both success and failure branches.',
  (report, context) => ({
    CallExpression(node) {
      if (!isMemberCall(node, 'Effect', new Set(['match']))) return
      const options = node.arguments.at(-1)
      const failure = objectProperty(options, 'onFailure')?.value
      const success = objectProperty(options, 'onSuccess')?.value
      if (
        (isFunction(failure) && /Effect\./u.test(sourceText(context, failure))) ||
        (isFunction(success) && /Effect\./u.test(sourceText(context, success)))
      ) {
        report(node)
      }
    },
  }),
)

const noAsyncCallbackApi = rule(
  'Keep synchronous collection APIs synchronous.',
  'A synchronous collection method cannot await an async callback. Use Effect.forEach with explicit concurrency.',
  (report) => ({
    CallExpression(node) {
      if (node.callee?.type !== 'MemberExpression') return
      if (!syncCallbackMethods.has(propertyName(node.callee))) return
      if (node.arguments.some((argument) => isFunction(argument) && argument.async === true))
        report(node)
    },
  }),
)

const noEffectWrapperForSyncCallbackApi = rule(
  'Do not hide synchronous collection work behind Promise adapters.',
  'This Effect Promise adapter returns a synchronous collection operation. Use Effect.sync or compose Effect.forEach.',
  (report) => ({
    CallExpression(node) {
      if (!isMemberCall(node, 'Effect', new Set(['promise', 'tryPromise']))) return
      const callback = node.arguments[0]
      if (!isFunction(callback)) return
      const expression = callback.body
      if (
        expression?.type === 'CallExpression' &&
        expression.callee?.type === 'MemberExpression' &&
        syncCallbackMethods.has(propertyName(expression.callee))
      ) {
        report(node)
      }
    },
  }),
)

const noHostTransformValidation = rule(
  'Validate values transformed by host JSON APIs.',
  'Host JSON transforms do not establish a domain type. Decode the result with a named Effect Schema at ingress.',
  (report) => ({
    CallExpression(node) {
      if (
        node.arguments.length === 0 &&
        node.callee?.type === 'MemberExpression' &&
        propertyName(node.callee) === 'json'
      )
        report(node)
    },
  }),
)

const effectNoServiceInsideMethod = rule(
  'Acquire Effect services once at the operation boundary.',
  'Do not yield a Context service inside an object method. Acquire dependencies in the Layer constructor and close over them.',
  (report, context) => ({
    Property(node) {
      if (!isFunction(node.value)) return
      const object = node.parent
      const call = object?.parent
      if (
        object?.type !== 'ObjectExpression' ||
        call?.type !== 'CallExpression' ||
        call.callee?.type !== 'MemberExpression' ||
        propertyName(call.callee) !== 'of'
      ) {
        return
      }
      if (/yield\s*\*\s*[A-Z][A-Za-z0-9_$]*/u.test(sourceText(context, node.value))) report(node)
    },
  }),
)

const effectNoContextGenericService = memberCallRule({
  description: 'Use Context.Service for named capability seams.',
  message:
    'Do not create a generic Context tag for an application service. Define a named Context.Service contract.',
  owner: 'Context',
  methods: new Set(['GenericTag', 'Tag']),
})

const effectNoServiceAccessor = rule(
  'Keep service methods on the yielded service value.',
  'Do not expose static service accessors. Yield the service and call object.method(...) through its receiver.',
  (report, context) => ({
    MethodDefinition(node) {
      if (node.static !== true || node.key?.type !== 'Identifier' || node.key.name === 'of') return
      const declaration = node.parent?.parent
      if (
        declaration?.type === 'ClassDeclaration' &&
        /extends\s+Context\.Service/u.test(sourceText(context, declaration))
      ) {
        report(node)
      }
    },
  }),
)

const effectNoServiceObjectSyntax = rule(
  'Declare Context.Service contracts as named interfaces.',
  'Do not place an inline object type in Context.Service. Name the service shape so it remains a reviewable contract.',
  (report, context) => ({
    ClassDeclaration(node) {
      if (/Context\.Service\s*<[^,>]+,\s*\{/u.test(sourceText(context, node))) report(node)
    },
  }),
)

const effectRequireEffectFn = rule(
  'Name non-trivial service operations with Effect.fn.',
  'Service operations that return Effect must use a named Effect.fn for traceability.',
  (report, context) => ({
    Property(node) {
      if (!isFunction(node.value) || node.value.async === true || node.value.returnType == null)
        return
      const returnType = sourceText(context, node.value.returnType)
      if (
        /\bEffect(?:\.|<)/u.test(returnType) &&
        !isMemberCall(node.value.body, 'Effect', new Set(['fn', 'fnUntraced']))
      ) {
        report(node)
      }
    },
  }),
)

const noConfigProviderFromEnvInLibrary = memberCallRule({
  description: 'Install environment config providers only at application startup.',
  message:
    'Do not install ConfigProvider.fromEnv in a library. Read Effect Config through the Layer graph owned by the entry point.',
  owner: 'ConfigProvider',
  methods: new Set(['fromEnv']),
})

const betterAuthSecureOptions = rule(
  'Keep Better Auth schema ownership and secrets explicit.',
  'Better Auth must disable implicit migrations and must not embed a literal secret.',
  (report) => ({
    Property(node) {
      const name = node.key?.type === 'Identifier' ? node.key.name : node.key?.value
      if (name === 'migrate' && node.value?.value !== false) report(node)
      if (name === 'secret' && isStringLiteral(node.value)) report(node)
    },
  }),
)

const requireDrizzleConfigPaths = rule(
  'Keep Drizzle schema and generated migration ownership explicit.',
  'Drizzle defineConfig requires literal schema and out paths; generated migrations must have one owning directory.',
  (report, context) => ({
    CallExpression(node) {
      if (!/(?:^|[/\\])drizzle\.config\.[cm]?[jt]s$/u.test(context.filename)) return
      if (node.callee?.type !== 'Identifier' || node.callee.name !== 'defineConfig') return
      const options = node.arguments[0]
      const schema = objectProperty(options, 'schema')?.value
      const out = objectProperty(options, 'out')?.value
      if (!isStringLiteral(schema) || !isStringLiteral(out)) report(node)
    },
  }),
)

const reactNoDerivedStateEffect = rule(
  'Derive render values during render rather than mirroring them through an Effect.',
  'Do not use an Effect only to copy a value into state. Derive it during render or reset state at an ownership boundary.',
  (report) => ({
    CallExpression(node) {
      if (node.callee?.type !== 'Identifier' || node.callee.name !== 'useEffect') return
      const callback = node.arguments[0]
      if (!isFunction(callback) || callback.body?.type !== 'BlockStatement') return
      const statements = callback.body.body
      if (statements.length !== 1 || statements[0].type !== 'ExpressionStatement') return
      const expression = statements[0].expression
      if (
        expression?.type === 'CallExpression' &&
        expression.callee?.type === 'Identifier' &&
        /^set[A-Z]/u.test(expression.callee.name)
      ) {
        report(node)
      }
    },
  }),
)

/** The functions `then`, `catch` and `finally` call later, when what they waited for has ended. */
const settlementMethods = new Set(['then', 'catch', 'finally'])

/** Whether `node` is a callback handed to a promise's `then`, `catch` or `finally`. */
const isSettlementCallback = (node) =>
  node.parent?.type === 'CallExpression' &&
  node.parent.arguments.includes(node) &&
  settlementMethods.has(propertyName(node.parent.callee))

/**
 * A setter `useState` returned, called from the far side of a wait.
 *
 * `const [busy, setBusy] = useState(false)` followed by `await save(); setBusy(false)` holds a
 * lifecycle in a component and moves it from a continuation that does not know whether the
 * attempt it belongs to is still the one on screen: the Person pressed again, opened something
 * else, or the screen was reused, and the older answer writes over the newer state. The survey of
 * 10 October 2026 found about forty such lifecycles in the clients and a concrete overwrite in
 * about twenty.
 *
 * A wait is an `await`, a `yield*` in a generator (an `Effect.gen` body waits there), or a
 * callback given to `then`, `catch` or `finally`. Setters are recognised by the `useState`
 * destructuring in the same file; one that reaches a function as a prop is not followed.
 *
 * This reads syntax, not types, so it cannot tell a lifecycle from a harmless note. It is a
 * warning with a ratchet for that reason: the count may only go down, and a new screen that needs
 * the pattern has to take a finding away first.
 *
 * What it does not follow, so its silence is not proof: a helper that sets state and is called
 * after the wait (`const end = () => setBusy(false); await send(); end()`), a setter reached
 * through a prop, and two bindings of one name in a file (names are tracked for the file). It
 * also reads a function top to bottom and not path by path, so a setter after a branch that
 * waited and returned is reported although that path never waited. The machine in
 * `packages/client/state` is what makes a lifecycle safe; this only counts the old shape.
 */
const reactNoStateAfterWait = rule(
  'Do not move React state from the far side of a wait.',
  '`{{setter}}` is called after this function has waited, with nothing to say the answer still belongs to the attempt on screen: an older answer can write over a newer press. A lifecycle with async work is a machine in packages/client/state (see connecting.ts), and a value the server owns is a live query.',
  (report) => {
    const setters = new Set()
    // One entry per function being visited, innermost last: whether it has waited yet.
    const waited = []
    const enter = (node) => waited.push(isSettlementCallback(node))
    const leave = () => waited.pop()
    const wait = () => {
      if (waited.length > 0) waited[waited.length - 1] = true
    }
    return {
      VariableDeclarator(node) {
        const made = unwrapExpression(node.init)
        if (made?.type !== 'CallExpression' || node.id?.type !== 'ArrayPattern') return
        const callee = made.callee
        const isUseState =
          (callee?.type === 'Identifier' && callee.name === 'useState') ||
          propertyName(callee) === 'useState'
        const setter = node.id.elements[1]
        if (isUseState && setter?.type === 'Identifier') setters.add(setter.name)
      },
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
      'FunctionDeclaration:exit': leave,
      'FunctionExpression:exit': leave,
      'ArrowFunctionExpression:exit': leave,
      // On the way out: what is awaited runs before the wait, so a setter inside it is not late.
      'AwaitExpression:exit': wait,
      'YieldExpression:exit'(node) {
        if (node.delegate) wait()
      },
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || !setters.has(node.callee.name)) return
        if (waited.at(-1) === true) report(node, { setter: node.callee.name })
      },
    }
  },
)

// Property and binding names that carry a closed lifecycle vocabulary in Vivid's contracts.
// `type` and `_tag` are left out on purpose: `type` names open vocabularies such as AST nodes, and
// raw `_tag` comparisons already belong to anti-slop-effect/no-manual-tag-comparison.
const stateNamePattern = /^(?:state|status|kind|phase)$|[a-z](?:State|Status|Kind|Phase)$/u
const terminalStatements = new Set([
  'BreakStatement',
  'ContinueStatement',
  'ReturnStatement',
  'ThrowStatement',
])

/**
 * Names a stable subject (`run`, `this.state`, `thread.run.status`) so two checks can be compared.
 * Calls and computed members return undefined: their value may differ between two evaluations, so
 * treating them as one subject would report unrelated predicates.
 */
const subjectKey = (node) => {
  const current = unwrapExpression(node)
  if (current?.type === 'Identifier') return current.name
  if (current?.type === 'ThisExpression') return 'this'
  if (current?.type !== 'MemberExpression' || current.computed) return undefined
  const owner = subjectKey(current.object)
  const name = propertyName(current)
  return owner === undefined || name === undefined ? undefined : `${owner}.${name}`
}

const stateCheck = (subject, cases) => ({ subject, cases })

/** `Union.guards.Case(value)`, the guard Schema.TaggedUnion generates per case in Effect 4.0.2. */
const guardStateCheck = (node) => {
  const callee = node.callee
  if (callee?.type !== 'MemberExpression' || propertyName(callee.object) !== 'guards')
    return undefined
  const union = subjectKey(callee.object.object)
  const value = node.arguments.length === 1 ? subjectKey(node.arguments[0]) : undefined
  const caseName = propertyName(callee)
  if (union === undefined || value === undefined || caseName === undefined) return undefined
  return stateCheck(`${union}(${value})`, [caseName])
}

/** `Union.isAnyOf(['A', 'B'])(value)`: one branch that covers several cases of the same union. */
const subsetStateCheck = (node) => {
  const predicate = node.callee
  if (predicate?.type !== 'CallExpression' || propertyName(predicate.callee) !== 'isAnyOf') {
    return undefined
  }
  const union = subjectKey(predicate.callee.object)
  const keys = predicate.arguments[0]
  const value = node.arguments.length === 1 ? subjectKey(node.arguments[0]) : undefined
  if (union === undefined || value === undefined || keys?.type !== 'ArrayExpression')
    return undefined
  if (!keys.elements.every(isStringLiteral)) return undefined
  return stateCheck(
    `${union}(${value})`,
    keys.elements.map((element) => element.value),
  )
}

/** `run.status === 'working'`: a string literal compared with a state-named property or binding. */
const literalStateCheck = (node) => {
  if (node.operator !== '===' && node.operator !== '==') return undefined
  const literal = [node.left, node.right].find(isStringLiteral)
  const other = unwrapExpression(literal === node.left ? node.right : node.left)
  if (literal === undefined) return undefined
  const name = other?.type === 'Identifier' ? other.name : propertyName(other)
  const subject = subjectKey(other)
  if (name === undefined || subject === undefined || !stateNamePattern.test(name)) return undefined
  return stateCheck(subject, [literal.value])
}

/**
 * Reads one `if` test as a check of a closed state, or undefined when it is anything else.
 * Only a pure check counts. `a || b` counts when both sides check the same subject; `&&`, negation,
 * and `!==` never count, because those are refinements and validation, not dispatch.
 */
const readStateCheck = (test) => {
  const node = unwrapExpression(test)
  if (node?.type === 'CallExpression') return guardStateCheck(node) ?? subsetStateCheck(node)
  if (node?.type === 'BinaryExpression') return literalStateCheck(node)
  if (node?.type !== 'LogicalExpression' || node.operator !== '||') return undefined
  const left = readStateCheck(node.left)
  const right = readStateCheck(node.right)
  if (left === undefined || right === undefined || left.subject !== right.subject) return undefined
  return stateCheck(left.subject, [...left.cases, ...right.cases])
}

const endsControlFlow = (statement) => {
  if (statement?.type !== 'BlockStatement') return terminalStatements.has(statement?.type)
  return terminalStatements.has(statement.body.at(-1)?.type)
}

/** Sibling statements of an `if` in a block, program, or switch case; empty for a bare `else if`. */
const siblingStatements = (node) => {
  const parent = node.parent
  if (parent?.type === 'SwitchCase') return parent.consequent
  return Array.isArray(parent?.body) ? parent.body : []
}

/** The first statement that does anything; `;` alone cannot change the subject. */
const firstEffectiveStatement = (statements) =>
  statements.find((statement) => statement.type !== 'EmptyStatement')

/**
 * The next check that observes the same value as `node`, or undefined.
 * Two checks are one dispatch only when nothing can run between them:
 * - `else if`, or a braced `else` whose first statement is the next `if`. A call or assignment
 *   before that `if` may change the subject, so the `if` after it is a separate observation.
 * - with no `else`, a branch that ends control flow followed directly by a guard that also ends
 *   it. Any statement between the two (a reassignment, a call that mutates the subject) breaks the
 *   run, and the scan never looks past it for a later `if`.
 */
const nextObservation = (node) => {
  const alternate = node.alternate
  if (alternate?.type === 'IfStatement') return alternate
  if (alternate?.type === 'BlockStatement') return firstEffectiveStatement(alternate.body)
  if (alternate !== null && alternate !== undefined) return undefined
  if (!endsControlFlow(node.consequent)) return undefined
  const siblings = siblingStatements(node)
  const next = firstEffectiveStatement(siblings.slice(siblings.indexOf(node) + 1))
  if (next?.type !== 'IfStatement' || next.alternate || !endsControlFlow(next.consequent)) {
    return undefined
  }
  return next
}

/**
 * Collects the `if` statements that continue one dispatch on `subject`, starting at `head`.
 * The run stops at the first statement that is not a check of the same subject. Function bodies
 * are never entered, so a nested callback starts its own dispatch on its own bindings.
 */
const collectDispatch = (head, subject) => {
  const branches = []
  let node = head
  while (node?.type === 'IfStatement') {
    const check = readStateCheck(node.test)
    if (check === undefined || check.subject !== subject) break
    branches.push([node, check.cases])
    node = nextObservation(node)
  }
  return branches
}

const preferStateMatch = rule(
  'Dispatch on a closed state with one exhaustive match instead of repeated if checks.',
  'These if branches dispatch on one closed state ({{cases}}), so a new case is silently skipped. Use the Schema.TaggedUnion matcher `Union.match(value, { ... })`, `Match.value(value).pipe(..., Match.exhaustive)`, or an exhaustive `switch` on a plain union.',
  (report) => {
    // Oxlint visits a parent before its children, so the first branch of a dispatch claims the
    // rest and the dispatch is reported once at its head.
    const claimed = new WeakSet()
    return {
      IfStatement(node) {
        if (claimed.has(node)) return
        const check = readStateCheck(node.test)
        if (check === undefined) return
        const branches = collectDispatch(node, check.subject)
        const cases = new Set(branches.flatMap(([, names]) => names))
        if (branches.length < 2 || cases.size < 2) return
        branches.forEach(([branch]) => claimed.add(branch))
        report(node, { cases: [...cases].join(', ') })
      },
    }
  },
)

const reactNoInlineContextValue = rule(
  'Keep React context provider values referentially stable.',
  'Do not create an object or array directly in a Context Provider value. Use a stable value owned by the provider.',
  (report) => ({
    JSXAttribute(node) {
      if (node.name?.name !== 'value') return
      const openingElement = node.parent
      const elementName = openingElement?.name
      const provider =
        elementName?.type === 'JSXMemberExpression' && elementName.property?.name === 'Provider'
      if (!provider) return
      const value = node.value?.expression
      if (value?.type === 'ObjectExpression' || value?.type === 'ArrayExpression') report(node)
    },
  }),
)

const reactNoUselessMemo = rule(
  'Reserve React memoization for work or identity that needs it.',
  'Do not memoize a literal or direct identifier. Use the value directly.',
  (report) => ({
    CallExpression(node) {
      if (node.callee?.type !== 'Identifier' || node.callee.name !== 'useMemo') return
      const callback = node.arguments[0]
      if (!isFunction(callback)) return
      const body = callback.body
      if (
        body?.type === 'Identifier' ||
        body?.type === 'Literal' ||
        body?.type === 'StringLiteral'
      ) {
        report(node)
      }
    },
  }),
)

/*
 * Failure rules. Each one is a way a Person's failed work went unseen in production on
 * 8-10 November 2026: every send failed for two days, and the server turned the cell's refusal
 * into "Vivid could not be reached" at warning level with no issue. The vocabulary they enforce
 * is `packages/contracts/src/incidents.ts`. They read syntax, not types, so each is a warning with
 * a ratchet in `scripts/gate/ratchets.mjs`: the count may only go down.
 *
 * Same-file bindings expose named handlers and object spreads. A decoded refusal remains a
 * failure even when a later statement replaces it outside a combinator. Imported implementations
 * and the outcomes of arbitrary calls remain unknown to these syntax rules.
 */

/** The combinators that replace one failure with another (`IncidentCause`'s keep-cause rule). */
const remapMethods = new Set(['catchTag', 'catchTags', 'mapError', 'catch', 'catchIf', 'orElse'])
/** The combinators whose handler may answer a success in place of the failure it caught. */
const recoveryMethods = new Set([
  'catch',
  'catchCause',
  'catchCauseIf',
  'catchFilter',
  'catchIf',
  'catchReason',
  'catchReasons',
  'catchTag',
  'catchTags',
])
/** Each turns any failure into a value or into nothing (`effect@4.0.2` `src/Effect.ts`). */
const valueMethods = new Set(['exit', 'ignore', 'ignoreCause', 'option', 'orElseSucceed', 'result'])
const failureOwners = new Set(['Effect', 'Layer', 'Stream'])
/** Handlers given as an object of tag to handler rather than as the last argument. */
const handlerObjectMethods = new Set(['catchReasons', 'catchTags'])
const successCalls = new Set([
  'as',
  'asVoid',
  'log',
  'logDebug',
  'logError',
  'logFatal',
  'logInfo',
  'logTrace',
  'logWarning',
  'succeed',
  'succeedNone',
  'succeedSome',
  'sync',
])
const successValues = new Set(['asVoid', 'succeedNone', 'void'])
const failCalls = new Set(['die', 'fail', 'failCause', 'failSync'])
const failureLogLevels = new Set(['logError', 'logFatal', 'logWarning'])
/**
 * What reports a failure before it becomes a value: the recorder (`Incidents`, or the `incidents`
 * a producer yields it as), the reporters and the observers.
 */
const reporterPattern =
  /\b(?:[Ii]ncidents|withErrorReporting|ErrorReporter|recordRefusal|recordRunFailure|observeFailures)\b/u
/** `// Impact: Recovered, <why>` or `// Impact: Routine, <why>`: the site says what it decided. */
const impactPattern = /\bImpact:\s*(?:Routine|Recovered)\b\W+\w[\s\S]{9,}/u
const pascalCase = /^[A-Z][A-Za-z0-9]*$/u

/** Whether `node` is `Owner.method` for one of `owners` and one of `methods`. */
const isOwnedMember = (node, owners, methods) =>
  node?.type === 'MemberExpression' &&
  node.object?.type === 'Identifier' &&
  owners.has(node.object.name) &&
  methods.has(propertyName(node))

const isEffectCall = (node, methods) =>
  node?.type === 'CallExpression' && isOwnedMember(node.callee, new Set(['Effect']), methods)

/** Walks `node`'s subtree in source order; `visit` returning false skips a node's children. */
const walkTree = (node, visit) => {
  if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return
  if (visit(node) === false) return
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key]
    if (Array.isArray(value)) value.forEach((child) => walkTree(child, visit))
    else walkTree(value, visit)
  }
}

/**
 * The error a construction makes: `new Name(...)` or `Name.make(...)`, including a case of a
 * tagged union (`Refusal.cases.AdmissionRefused.make`). Undefined for anything else.
 */
const constructedError = (node) => {
  const expression = unwrapExpression(node)
  if (expression?.type === 'NewExpression') {
    const callee = unwrapExpression(expression.callee)
    const name = callee?.type === 'Identifier' ? callee.name : propertyName(callee)
    return name !== undefined && pascalCase.test(name) ? { node: expression, name } : undefined
  }
  if (expression?.type !== 'CallExpression') return undefined
  const callee = unwrapExpression(expression.callee)
  if (callee?.type !== 'MemberExpression' || propertyName(callee) !== 'make') return undefined
  const owner = unwrapExpression(callee.object)
  const name = owner?.type === 'Identifier' ? owner.name : propertyName(owner)
  return name !== undefined && pascalCase.test(name) ? { node: expression, name } : undefined
}

/** Resolve the nearest lexical binding, never a same-named declaration in another scope. */
const bindingOf = (context, node) => {
  for (let scope = context.sourceCode.getScope(node); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(node.name)
    if (variable !== undefined) return variable
  }
  return undefined
}

/** Only visible object literals prove that a spread carries `cause`; unknown spreads do not. */
const objectHasCause = (context, node, seen = new Set()) => {
  const fields = unwrapExpression(node)
  if (fields?.type === 'Identifier') {
    const definition = bindingOf(context, fields)?.defs[0]
    if (definition?.parent?.kind !== 'const' || seen.has(definition.node)) return false
    seen.add(definition.node)
    return objectHasCause(context, definition.node.init, seen)
  }
  if (fields?.type !== 'ObjectExpression') return false
  if (objectProperty(fields, 'cause') !== undefined) return true
  return fields.properties.some(
    (property) =>
      property.type === 'SpreadElement' && objectHasCause(context, property.argument, seen),
  )
}

/** A direct opaque argument keeps the old unknown result; visible fields must carry a cause. */
const passesCause = (context, construction) => {
  const fields = unwrapExpression(construction.node.arguments[0])
  if (fields === undefined) return false
  if (fields.type !== 'ObjectExpression') return true
  return objectHasCause(context, fields)
}

/** The generator an `Effect.fn('name')(function* ...)` or `Effect.fnUntraced(...)` wraps. */
const wrappedGenerator = (node) => {
  const expression = unwrapExpression(node)
  if (expression?.type !== 'CallExpression') return undefined
  const callee = unwrapExpression(expression.callee)
  const named = isEffectCall(callee, new Set(['fn']))
  const direct = isOwnedMember(callee, new Set(['Effect']), new Set(['fn', 'fnUntraced', 'gen']))
  if (!named && !direct) return undefined
  const body = expression.arguments.find(isFunction)
  return body?.generator === true ? body : undefined
}

/** A same-file function declaration or const has a body just as an inline handler does. */
const handlerFunction = (context, node) => {
  let expression = unwrapExpression(node)
  if (expression?.type === 'Identifier') {
    const definition = bindingOf(context, expression)?.defs[0]
    if (definition?.type === 'FunctionName') return definition.node
    if (definition?.parent?.kind !== 'const') return undefined
    expression = unwrapExpression(definition.node.init)
  }
  return isFunction(expression) ? expression : wrappedGenerator(expression)
}

/** The handlers of a failure combinator call, each with the tags it catches when they are literal. */
const handlersOf = (context, call) => {
  const method = propertyName(call.callee)
  if (handlerObjectMethods.has(method)) {
    const handlers = call.arguments.find((argument) => argument?.type === 'ObjectExpression')
    if (handlers === undefined) return []
    return handlers.properties.flatMap((property) => {
      const handler =
        property.type === 'Property' ? handlerFunction(context, property.value) : undefined
      const tag = property.key?.type === 'Identifier' ? property.key.name : property.key?.value
      return handler === undefined ? [] : [{ handler, caught: new Set([tag]) }]
    })
  }
  const handler = handlerFunction(context, call.arguments.at(-1))
  if (handler === undefined) return []
  const tags = method === 'catchTag' ? unwrapExpression(call.arguments[0]) : undefined
  const literals = tags?.type === 'ArrayExpression' ? tags.elements : [tags]
  return [{ handler, caught: new Set(literals.filter(isStringLiteral).map((tag) => tag.value)) }]
}

/** The values a function answers with: its expression body, or what its own `return`s give. */
const resultsOf = (fn) => {
  if (fn.body?.type !== 'BlockStatement') return [fn.body]
  const results = []
  walkTree(fn.body, (node) => {
    if (isFunction(node)) return false
    if (node.type === 'ReturnStatement') results.push(node.argument)
    return true
  })
  return results
}

/**
 * What an Effect expression does with the failure it stands in for: `success` for the forms
 * that cannot fail (`Effect.succeed`, `Effect.void`, a log line), `fail` for a failure or an
 * error made in place, `unknown` for anything a name or a call hides.
 */
const effectOutcome = (node) => {
  const expression = unwrapExpression(node)
  if (constructedError(expression) !== undefined || isEffectCall(expression, failCalls))
    return 'fail'
  if (isEffectCall(expression, successCalls)) return 'success'
  if (isOwnedMember(expression, new Set(['Effect']), successValues)) return 'success'
  const generator = wrappedGenerator(expression)
  if (generator !== undefined) return functionOutcome(generator)
  // `work.pipe(..., Effect.as(value))`: whatever `work` was, the caught failure became `value`.
  if (expression?.type === 'CallExpression' && propertyName(expression.callee) === 'pipe') {
    const last = unwrapExpression(expression.arguments.at(-1))
    if (
      isEffectCall(last, new Set(['as'])) ||
      isOwnedMember(last, new Set(['Effect']), successValues)
    )
      return 'success'
  }
  if (expression?.type === 'ConditionalExpression') {
    const branches = new Set([
      effectOutcome(expression.consequent),
      effectOutcome(expression.alternate),
    ])
    return branches.size === 1 ? [...branches][0] : 'unknown'
  }
  return 'unknown'
}

/** Whether a generator fails in place: `yield*` of a made error or of `Effect.fail(...)`. */
const failsInPlace = (generator) => {
  let fails = false
  walkTree(generator.body, (node) => {
    if (isFunction(node)) return false
    if (node.type === 'YieldExpression' && node.delegate && effectOutcome(node.argument) === 'fail')
      fails = true
    return !fails
  })
  return fails
}

/**
 * What a handler answers. A generator answers success with any plain `return` value and with no
 * `return` at all; a `return yield* x` answers what `x` does. An arrow answers its Effect.
 */
function functionOutcome(fn) {
  if (fn.generator === true) {
    if (failsInPlace(fn)) return 'fail'
    const outcomes = resultsOf(fn).map((result) => {
      const value = unwrapExpression(result)
      return value?.type === 'YieldExpression' && value.delegate
        ? effectOutcome(value.argument)
        : 'success'
    })
    if (outcomes.includes('fail')) return 'fail'
    return outcomes.every((outcome) => outcome === 'success') ? 'success' : 'unknown'
  }
  const outcomes = resultsOf(fn).map(effectOutcome)
  if (outcomes.includes('fail')) return 'fail'
  if (outcomes.length > 0 && outcomes.every((outcome) => outcome === 'success')) return 'success'
  return 'unknown'
}

/** The errors a handler makes and fails with: `Effect.fail(new X)`, `yield* X.make()`, or returns one. */
const failingConstructions = (handler, mapsError) => {
  const found = []
  const add = (node) => {
    const construction = constructedError(node)
    if (construction !== undefined) found.push(construction)
  }
  walkTree(handler.body, (node) => {
    // A nested failure combinator is a site of its own and is read when the rule reaches it.
    if (node.type === 'CallExpression' && isOwnedMember(node.callee, failureOwners, remapMethods))
      return false
    if (isEffectCall(node, failCalls)) add(node.arguments[0])
    if (node.type === 'YieldExpression' && node.delegate) add(node.argument)
    return true
  })
  if (mapsError || handler.generator !== true) resultsOf(handler).forEach(add)
  return found
}

/** Whether a handler ever reads the failure it was given. */
const readsCaughtFailure = (context, handler) =>
  context.sourceCode
    .getDeclaredVariables(handler)
    .some(
      (variable) =>
        variable.references.length > 0 &&
        variable.defs.some((definition) => definition.type === 'Parameter'),
    )

/** A refusal decoded earlier in this lexical scope is still available to carry into a failure. */
const hasDecodedRefusal = (context, node) => {
  for (let scope = context.sourceCode.getScope(node); scope !== null; scope = scope.upper) {
    for (const variable of scope.variables) {
      const declaration = variable.defs[0]?.node
      if (declaration?.type !== 'VariableDeclarator' || declaration.range[1] >= node.range[0])
        continue
      let refused = false
      walkTree(declaration.init, (part) => {
        if (part.type === 'CallExpression' && propertyName(part.callee) === 'schemaBodyJson') {
          const schema = part.arguments[0]
          if (schema?.type === 'Identifier' && refusalTag.test(schema.name)) refused = true
        }
        return !isFunction(part)
      })
      if (refused) return true
    }
  }
  return false
}

/**
 * `IncidentCause`'s keep-cause rule (`packages/contracts/src/incidents.ts`), the first link that
 * broke on 8 November 2026: the cell answered 400 for a field the server sent, the server's
 * `Runtime.admit` turned it into `AdmissionRefused{Rejected}`, `Conversation.admitRuntime` turned
 * that into `RuntimeUnavailable`, and nothing said which field. A handler that fails with a new
 * error must give it the caught error's cause; a handler that never reads what it caught and does
 * not answer success has dropped the cause whatever it returns.
 */
const keepIncidentCause = {
  meta: {
    type: 'problem',
    docs: { description: 'A failure replaced by another keeps its cause (IncidentCause).' },
    schema: [],
    messages: {
      replaced:
        "`{{name}}` replaces the caught failure without its cause. Give `{{name}}` a `cause: IncidentCause` field and pass the caught error's chain with this hop in front: { service, operation: <this Effect.fn name>, tag: <caught tag> } (packages/contracts/src/incidents.ts, IncidentCause).",
      dropped:
        'This handler never reads the failure it caught and answers with something else, so why it failed is lost. Take the caught error and carry its cause into what you fail or answer with: `cause: IncidentCause` with this hop in front (packages/contracts/src/incidents.ts). A handler that answers success is recovery and is not this rule.',
    },
  },
  create(context) {
    return {
      YieldExpression(node) {
        if (!node.delegate) return
        const construction = constructedError(node.argument)
        if (construction === undefined || passesCause(context, construction)) return
        if (!hasDecodedRefusal(context, node)) return
        context.report({
          node: construction.node,
          messageId: 'replaced',
          data: { name: construction.name },
        })
      },
      CallExpression(node) {
        if (!isOwnedMember(node.callee, failureOwners, remapMethods)) return
        const mapsError = propertyName(node.callee) === 'mapError'
        for (const { handler, caught } of handlersOf(context, node)) {
          const replaced = failingConstructions(handler, mapsError).filter(
            (construction) => !caught.has(construction.name) && !passesCause(context, construction),
          )
          replaced.forEach((construction) =>
            context.report({
              node: construction.node,
              messageId: 'replaced',
              data: { name: construction.name },
            }),
          )
          if (replaced.length > 0 || readsCaughtFailure(context, handler)) continue
          if (mapsError || functionOutcome(handler) !== 'success')
            context.report({ node: handler, messageId: 'dropped' })
        }
      },
    }
  },
}

/** Tags that say another party refused, as opposed to could not be reached. */
const refusalTag =
  /(?:Refused|Rejected|Refusal|Denied|Forbidden|Unauthorized|Unauthenticated|Conflict|NotFound|^Invalid\w*|^Wrong\w*|^Unknown\w*)$/u

/**
 * A refusal renamed to unavailable. `Conversation.admitRuntime` caught `AdmissionRefused` (the
 * cell answered 400) and failed with `RuntimeUnavailable`, "Vivid could not be reached", so the
 * Person, the phone and the log all read an outage when the cell had said exactly what was wrong.
 * `RuntimeUnavailable` and its kind mean genuine unavailability only.
 */
const noRefusalAsUnavailable = {
  meta: {
    type: 'problem',
    docs: { description: 'A refusal is never renamed to an unavailable failure.' },
    schema: [],
    messages: {
      renamed:
        '`{{caught}}` is a refusal and `{{name}}` says Vivid could not be reached. A refusal is never renamed to unavailable: keep `{{caught}}`, or fail with a refusal the caller can tell apart, and carry its cause (`cause: IncidentCause`, packages/contracts/src/incidents.ts).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isOwnedMember(node.callee, failureOwners, remapMethods)) return
        for (const { handler, caught } of handlersOf(context, node)) {
          const refused = [...caught].find((tag) => refusalTag.test(tag))
          if (refused === undefined) continue
          failingConstructions(handler, false)
            .filter((construction) => construction.name.endsWith('Unavailable'))
            .forEach((construction) =>
              context.report({
                node: construction.node,
                messageId: 'renamed',
                data: { caught: refused, name: construction.name },
              }),
            )
        }
      },
    }
  },
}

/** The statement a site belongs to: what is read for a reporter and an `Impact` comment. */
const enclosingStatement = (node) => {
  let current = node
  while (current?.parent !== undefined && current.parent !== null) {
    if (/(?:Statement|Declaration)$/u.test(current.type) && current.type !== 'BlockStatement')
      return current
    current = current.parent
  }
  return current
}

/** Whether the site reports its failure or says which `Impact` it decided, beside itself. */
const siteAccountsForFailure = (context, site) => {
  const statement = enclosingStatement(site)
  if (reporterPattern.test(sourceText(context, statement))) return true
  const first = statement.loc.start.line - 1
  const last = site.loc.start.line
  return context.sourceCode
    .getAllComments()
    .some(
      (comment) =>
        comment.loc.end.line >= first &&
        comment.loc.end.line <= last &&
        impactPattern.test(comment.value),
    )
}

/**
 * A failure turned into a value with nobody told: `Effect.result`, `option`, `exit`, `ignore`,
 * `orElseSucceed`, or a catch whose handler answers success. On 8-10 November 2026 a Run that
 * ended `Unknown` (`runtime/settlement.ts`), a rejected push (`push/delivery.ts`) and a Computer
 * that did not start (`computers/store.ts`) were all successful Effects, and none was recorded.
 * The site records it (`Incidents.record`, `Effect.withErrorReporting`) or declares the impact it
 * decided on the lines above it, with a reason.
 */
const noSilentFailure = {
  meta: {
    type: 'problem',
    docs: { description: 'A failure that becomes a value is recorded or its impact declared.' },
    schema: [],
    messages: {
      silent:
        "{{form}} turns a failure into a value and nothing says so. Record it where it is decided, before it becomes a value: `Incidents.record(...)` (apps/server/src/observability/incidents.ts) or `Effect.withErrorReporting`. If it is the Person's own decision or was recovered from, say so above this line: `// Impact: Routine, <why>` or `// Impact: Recovered, <why>` (Impact in packages/contracts/src/monitoring.ts).",
    },
  },
  create(context) {
    const report = (node, form) => {
      if (!siteAccountsForFailure(context, node))
        context.report({ node, messageId: 'silent', data: { form } })
    }
    return {
      MemberExpression(node) {
        if (isOwnedMember(node, new Set(['Effect']), valueMethods))
          report(node, `\`Effect.${propertyName(node)}\``)
      },
      CallExpression(node) {
        if (!isOwnedMember(node.callee, new Set(['Effect']), recoveryMethods)) return
        const method = propertyName(node.callee)
        const handlers = handlersOf(context, node)
        if (
          handlers.some(
            ({ handler }) =>
              functionOutcome(handler) === 'success' && !siteAccountsForFailure(context, handler),
          )
        )
          report(node.callee, `This \`Effect.${method}\` answers success, so it`)
      },
    }
  },
}

const isMessageConstant = (node) => {
  const expression = unwrapExpression(node)
  return (
    expression?.type === 'MemberExpression' &&
    unwrapExpression(expression.object)?.type === 'Identifier' &&
    unwrapExpression(expression.object).name === 'Message'
  )
}

/**
 * A warning or error line written by hand. The exporter keeps a body only when it is one of
 * `Message`'s constants and drops every attribute it does not know (`observability/export.ts`), so
 * such a line reaches the backend as `[omitted]`: 65 of them in one day of November 2026, the
 * Computer's start failure among them. A failure goes through the recorder; any other line writes
 * a `Message` constant.
 */
const noAdHocFailureLog = rule(
  'Failure lines go through the recorder or a fixed Message constant.',
  "`Effect.{{level}}` {{what}} reaches the backend as `[omitted]`. A Person's failed work is `Incidents.record(...)` and a failure at a boundary is `observeFailures`; any other line writes one `Message` constant (apps/server/src/observability/messages.ts) and puts closed attributes in `Effect.annotateLogs`.",
  (report) => ({
    MemberExpression(node) {
      if (!isOwnedMember(node, new Set(['Effect']), failureLogLevels)) return
      const level = propertyName(node)
      const call = node.parent
      if (call?.type !== 'CallExpression' || call.callee !== node) {
        report(node, { level, what: 'given the failure itself as its payload' })
        return
      }
      if (call.arguments.length === 1 && isMessageConstant(call.arguments[0])) return
      const what = isMessageConstant(call.arguments[0])
        ? 'with a payload beside its Message'
        : 'with a message that is not a `Message` constant'
      report(call, { level, what })
    },
  }),
)

const typednessWords =
  /\b(?:Expected|Defect|expected|defect|isDieReason|isFailReason|hasDies|hasFails)\b/u
const levelChoice =
  /\bEffect\.log(?:Trace|Debug|Info|Warning|Error|Fatal)\b|\blevel\s*:|\bissue\s*:/u

/**
 * Severity chosen by whether a failure was declared. `failure.ts` logged every typed failure as a
 * warning and every defect as an error, so the refusal that failed every send for two days was a
 * warning nobody was paged for. Severity comes from impact: `impactSignal[impact]`.
 */
const severityFromImpact = rule(
  'Choose log level and issue eligibility from impact, not from typedness.',
  'Severity is chosen here by whether the failure was declared (expected or defect). Choose it from impact: `impactSignal[impactOfFailure(failure)]` (packages/contracts/src/monitoring.ts), or the Impact a recorder decided; expected or defect stays an attribute only.',
  (report, context) => {
    const choosesLevel = (node) =>
      node !== null && node !== undefined && levelChoice.test(sourceText(context, node))
    return {
      ObjectExpression(node) {
        const keys = node.properties.flatMap((property) =>
          property.type === 'Property' && property.key?.type === 'Identifier'
            ? [property.key.name]
            : [],
        )
        const typed = ['Expected', 'Defect'].every((key) => keys.includes(key))
        if (typed && choosesLevel(node)) report(node)
      },
      ConditionalExpression(node) {
        if (typednessWords.test(sourceText(context, node.test)) && choosesLevel(node.consequent))
          report(node)
      },
      IfStatement(node) {
        if (typednessWords.test(sourceText(context, node.test)) && choosesLevel(node.consequent))
          report(node)
      },
    }
  },
)

export default {
  meta: { name: 'vivid' },
  rules: {
    'better-auth-secure-options': betterAuthSecureOptions,
    'effect-no-context-generic-service': effectNoContextGenericService,
    'effect-no-service-accessor': effectNoServiceAccessor,
    'effect-no-service-inside-method': effectNoServiceInsideMethod,
    'effect-no-service-object-syntax': effectNoServiceObjectSyntax,
    'effect-prefer-match-effect': effectPreferMatchEffect,
    'effect-require-effect-fn': effectRequireEffectFn,
    'keep-incident-cause': keepIncidentCause,
    'no-ad-hoc-failure-log': noAdHocFailureLog,
    'no-async-callback-api': noAsyncCallbackApi,
    'no-config-provider-from-env-in-library': noConfigProviderFromEnvInLibrary,
    'no-cross-package-import': noCrossPackageImport,
    'no-direct-process-env': noDirectProcessEnv,
    'no-direct-schema-safeparse': noDirectSchemaSafeParse,
    'no-effect-catch-raw-error': noEffectCatchRawError,
    'no-effect-option-constructors': noEffectOptionConstructors,
    'no-effect-runtime-api': noEffectRuntimeApi,
    'no-effect-wrapper-for-sync-callback-api': noEffectWrapperForSyncCallbackApi,
    'no-global-process-runtime': noGlobalProcessRuntime,
    'no-host-transform-validation': noHostTransformValidation,
    'no-inline-schema-compile': noInlineSchemaCompile,
    'no-manual-effect-runtime-in-tests': noManualEffectRuntimeInTests,
    'no-non-null-assertion': noNonNullAssertion,
    'no-optional-chaining': noOptionalChaining,
    'no-parse-method-alias': noParseMethodAlias,
    'no-platform-runtime-runmain-in-library': noPlatformRuntimeRunMainInLibrary,
    'no-promise-constructor': noPromiseConstructor,
    'no-refusal-as-unavailable': noRefusalAsUnavailable,
    'no-runpromise-in-library': noRunPromiseInLibrary,
    'no-runpromise-nested': noRunPromiseNested,
    'no-runtime-env-mutation': noRuntimeEnvMutation,
    'no-silent-failure': noSilentFailure,
    'no-try-catch': noTryCatch,
    'no-undefined-in-union': noUndefinedInUnion,
    'no-unnecessary-die': noUnnecessaryDie,
    'prefer-state-match': preferStateMatch,
    'namespace-node-imports': namespaceNodeImports,
    'react-no-derived-state-effect': reactNoDerivedStateEffect,
    'react-no-inline-context-value': reactNoInlineContextValue,
    'react-no-state-after-wait': reactNoStateAfterWait,
    'react-no-useless-memo': reactNoUselessMemo,
    'require-drizzle-config-paths': requireDrizzleConfigPaths,
    'require-named-effect-fn': requireNamedEffectFn,
    'require-schema-class-identifier': requireSchemaClassIdentifier,
    'require-schema-class-title': requireSchemaClassTitle,
    'require-schema-decode-in-boundary': requireSchemaDecodeInBoundary,
    'severity-from-impact': severityFromImpact,
  },
}
