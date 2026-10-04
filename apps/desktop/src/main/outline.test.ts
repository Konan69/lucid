import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { AccessibilityTree, OUTLINE_LIMIT, findControl, outline } from './outline.ts'

const decode = Schema.decodeUnknownSync(AccessibilityTree)
const text = (value: string) => ({ type: 'string', value })
const none: ReadonlySet<number> = new Set()

/** A sign-in page as Chromium's accessibility domain describes one, extra fields included. */
const signIn = decode({
  nodes: [
    {
      nodeId: '1',
      ignored: false,
      role: text('RootWebArea'),
      name: text('Sign in'),
      childIds: ['2', '3', '6', '8', '10'],
      backendDOMNodeId: 1,
      chromeRole: { type: 'internalRole', value: 144 },
    },
    {
      nodeId: '2',
      role: text('heading'),
      name: text('Sign in'),
      parentId: '1',
      childIds: ['20'],
      backendDOMNodeId: 2,
    },
    { nodeId: '20', role: text('StaticText'), name: text('Sign in'), parentId: '2' },
    { nodeId: '3', ignored: true, parentId: '1', childIds: ['4'] },
    {
      nodeId: '4',
      role: text('textbox'),
      name: text('Email'),
      value: text('ada@example.com'),
      parentId: '3',
      backendDOMNodeId: 4,
      properties: [
        { name: 'focusable', value: { type: 'booleanOrUndefined', value: true } },
        { name: 'focused', value: { type: 'booleanOrUndefined', value: true } },
      ],
    },
    {
      nodeId: '6',
      role: text('button'),
      name: text('Sign in'),
      parentId: '1',
      childIds: ['7'],
      backendDOMNodeId: 6,
    },
    { nodeId: '7', role: text('StaticText'), name: text('Sign in'), parentId: '6' },
    {
      nodeId: '8',
      role: text('button'),
      name: text('Continue'),
      parentId: '1',
      backendDOMNodeId: 8,
      properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }],
    },
    {
      nodeId: '10',
      role: text('paragraph'),
      parentId: '1',
      childIds: ['11'],
    },
    { nodeId: '11', role: text('StaticText'), name: text('Forgot it?'), parentId: '10' },
  ],
})

describe('the page as an outline', () => {
  it('reads the page in order, with values and states, and says a name once', () => {
    expect(outline(signIn, none).text).toBe(
      [
        'heading "Sign in"',
        'textbox "Email" = "ada@example.com" (focused)',
        'button "Sign in"',
        'button "Continue" (disabled)',
        'text "Forgot it?"',
      ].join('\n'),
    )
    expect(outline(signIn, none).truncated).toBe(false)
  })

  it('finds a control by its words, whatever their case, for the use asked', () => {
    const { controls } = outline(signIn, none)
    expect(Option.map(findControl(controls, 'sign in', 'click'), (found) => found.node)).toEqual(
      Option.some(6),
    )
    expect(Option.map(findControl(controls, 'EMAIL', 'type'), (found) => found.node)).toEqual(
      Option.some(4),
    )
  })

  it('refuses what cannot be used that way, what is disabled and what is not there', () => {
    const { controls } = outline(signIn, none)
    expect(Option.isNone(findControl(controls, 'Sign in', 'type'))).toBe(true)
    expect(Option.isNone(findControl(controls, 'Continue', 'click'))).toBe(true)
    expect(Option.isNone(findControl(controls, 'Register', 'click'))).toBe(true)
  })

  it('never chooses between two controls with the same words', () => {
    const twice = decode({
      nodes: [
        { nodeId: '1', role: text('RootWebArea'), childIds: ['2', '3'] },
        {
          nodeId: '2',
          role: text('button'),
          name: text('Delete'),
          parentId: '1',
          backendDOMNodeId: 2,
        },
        {
          nodeId: '3',
          role: text('button'),
          name: text('Delete'),
          parentId: '1',
          backendDOMNodeId: 3,
        },
      ],
    })
    expect(Option.isNone(findControl(outline(twice, none).controls, 'Delete', 'click'))).toBe(true)
  })

  it('cuts a long page at the limit and says so', () => {
    const long = decode({
      nodes: [
        { nodeId: '0', role: text('RootWebArea'), childIds: ['1'] },
        {
          nodeId: '1',
          role: text('paragraph'),
          name: text('x'.repeat(OUTLINE_LIMIT)),
          parentId: '0',
        },
      ],
    })
    const read = outline(long, none)
    expect(read.truncated).toBe(true)
    expect(read.text).toHaveLength(OUTLINE_LIMIT)
  })

  it('never says what a password field holds, however the tree reports it', () => {
    const secret = decode({
      nodes: [
        { nodeId: '1', role: text('RootWebArea'), childIds: ['2', '4'] },
        {
          nodeId: '2',
          role: text('textbox'),
          name: text('Password'),
          value: text('hunter2'),
          parentId: '1',
          childIds: ['3'],
          backendDOMNodeId: 9,
        },
        { nodeId: '3', role: text('StaticText'), name: text('hunter2'), parentId: '2' },
        {
          nodeId: '4',
          role: text('button'),
          name: text('Sign in'),
          parentId: '1',
          backendDOMNodeId: 10,
        },
      ],
    })
    const read = outline(secret, new Set([9]))
    expect(read.text).toBe('textbox "Password" = "(hidden)"\nbutton "Sign in"')
    expect(read.text).not.toContain('hunter2')
    // The field can still be named and typed into.
    expect(Option.isSome(findControl(read.controls, 'Password', 'type'))).toBe(true)
    // An empty password field says the same, so the outline does not reveal whether one is set.
    expect(outline(secret, new Set([9, 10])).text).toContain('button "Sign in" = "(hidden)"')
  })
})
