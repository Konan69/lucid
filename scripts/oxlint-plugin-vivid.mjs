const effectTerminalOperations = new Set([
  'runCallback',
  'runFork',
  'runPromise',
  'runPromiseExit',
  'runSync',
  'runSyncExit',
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
const manualEffectRuntimeMethods = new Set(['runFork', 'runPromise', 'runSync'])
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
  (report) => ({
    MemberExpression(node) {
      if (
        node.object?.type === 'MemberExpression' &&
        node.object.object?.type === 'Identifier' &&
        node.object.object.name === 'process' &&
        propertyName(node.object) === 'env'
      ) {
        report(node)
      }
    },
  }),
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
      if (/(?:^|[/\\])(main|server|cli|app)\.[cm]?[jt]s$/u.test(context.filename)) return
      report(node)
    },
  }),
)

const noPlatformRuntimeRunMainInLibrary = memberCallRule({
  description: 'Keep platform runtime launch at the executable entry point.',
  message:
    'Do not call NodeRuntime.runMain from a library module. Export the Effect and launch it from main.ts.',
  owner: 'NodeRuntime',
  methods: new Set(['runMain']),
})

const noEffectRuntimeApi = memberCallRule({
  description: 'Avoid creating hidden Effect runtimes in application modules.',
  message:
    'Do not create or execute a private Effect Runtime here. Use the application Layer graph and its single runtime boundary.',
  owner: 'Runtime',
  methods: new Set(['defaultRuntime', 'make', 'runCallback', 'runFork', 'runPromise', 'runSync']),
})

const noUnnecessaryDie = memberCallRule({
  description: 'Preserve expected failures in the typed error channel.',
  message: 'Do not terminate an expected failure with orDie/orDieWith. Keep it typed until the owning boundary.',
  owner: 'Effect',
  methods: new Set(['orDie', 'orDieWith']),
})

const noEffectCatchRawError = rule(
  'Require schema-backed expected errors in Effect recovery.',
  'Do not construct or fail with a raw Error inside Effect recovery. Return a schema-backed tagged error.',
  (report, context) => ({
    CallExpression(node) {
      if (!isMemberCall(node, 'Effect', new Set(['catch', 'catchAll', 'catchTag', 'catchTags']))) return
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
      if (node.callee?.type !== 'MemberExpression' || propertyName(node.callee) !== 'safeParse') return
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
      description: 'Use @effect/vitest instead of manually running Effect programs in Vitest files.',
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

// One predictable namespace per built-in keeps receiver calls intact and Node dependencies obvious.
const namespaceNodeImports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require canonical namespace imports for Node.js built-in modules.',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!isStringLiteral(node.source) || !node.source.value.startsWith('node:')) return
        const expectedAlias = expectedNodeNamespace(node.source.value)
        const namespaceImport =
          node.specifiers.length === 1 && node.specifiers[0]?.type === 'ImportNamespaceSpecifier'
            ? node.specifiers[0]
            : undefined
        if (namespaceImport?.local?.name === expectedAlias) return
        context.report({
          node,
          message: `Import ${node.source.value} as a namespace named ${expectedAlias}.`,
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
      if (current.arguments.some((argument) => objectProperty(argument, 'title') !== undefined)) return true
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
      if (schemaFactoryCall(node.superClass) !== undefined && !hasSchemaIdentifier(node.superClass)) {
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
      if (node.arguments.some((argument) => isFunction(argument) && argument.async === true)) report(node)
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
      ) report(node)
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
  message: 'Do not create a generic Context tag for an application service. Define a named Context.Service contract.',
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
      if (!isFunction(node.value) || node.value.async === true || node.value.returnType == null) return
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
  (report, context) => ({
    Property(node) {
      if (!/(?:^|[/\\])auth\.[cm]?[jt]s$/u.test(context.filename)) return
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
      if (body?.type === 'Identifier' || body?.type === 'Literal' || body?.type === 'StringLiteral') {
        report(node)
      }
    },
  }),
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
    'no-async-callback-api': noAsyncCallbackApi,
    'no-config-provider-from-env-in-library': noConfigProviderFromEnvInLibrary,
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
    'no-runpromise-in-library': noRunPromiseInLibrary,
    'no-runpromise-nested': noRunPromiseNested,
    'no-runtime-env-mutation': noRuntimeEnvMutation,
    'no-try-catch': noTryCatch,
    'no-undefined-in-union': noUndefinedInUnion,
    'no-unnecessary-die': noUnnecessaryDie,
    'namespace-node-imports': namespaceNodeImports,
    'react-no-derived-state-effect': reactNoDerivedStateEffect,
    'react-no-inline-context-value': reactNoInlineContextValue,
    'react-no-useless-memo': reactNoUselessMemo,
    'require-drizzle-config-paths': requireDrizzleConfigPaths,
    'require-named-effect-fn': requireNamedEffectFn,
    'require-schema-class-identifier': requireSchemaClassIdentifier,
    'require-schema-class-title': requireSchemaClassTitle,
    'require-schema-decode-in-boundary': requireSchemaDecodeInBoundary,
  },
}
