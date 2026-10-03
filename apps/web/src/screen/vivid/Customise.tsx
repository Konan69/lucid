import {
  Appearance,
  FaceHue,
  FaceOutline,
  Look,
  VIVID_NAME_MAX,
  VividName,
  Workspace,
  type MeResponse,
} from '@vivid/contracts'
import { Option, Result, Schema } from 'effect'
import { X } from 'lucide-react'
import { useId, useRef, useState, type FormEvent, type RefObject } from 'react'
import { live, useLiveValue } from '../../data/live'
import { faceColorOf, saveAppearance, useAppearance } from '../../data/vivid'
import { IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Face, FACE_COLOR_CLASS, type FaceColor, type FaceMood } from '../../ui/Face'
import { holdFocus, keepFocusInside, Layer } from '../../ui/Layer'

/** Every look there is to choose, in the order they are shown: the theme's own colour first. */
const LOOKS: ReadonlyArray<Look> = [
  Look.cases.Accent.make({}),
  ...FaceHue.literals.map((hue) => Look.cases.Hue.make({ hue })),
]

/** What an outline is called to someone who cannot see it. */
const outlineName = (outline: FaceOutline) =>
  `${outline.charAt(0).toUpperCase()}${outline.slice(1)}`

/** What a look is called to someone who cannot see it. */
const lookName = (look: Look) =>
  Look.match(look, {
    Accent: () => 'Theme colour',
    Hue: ({ hue }) => `${hue.charAt(0).toUpperCase()}${hue.slice(1)}`,
  })

/** The Company whose Vivid this is. Everyone there shares one, so the sheet says whose it is. */
const companyOf = (me: MeResponse) =>
  Workspace.match(me.workspace, {
    Personal: () => Option.none<string>(),
    Company: ({ company }) => Option.some(company.name),
  })

const decodeName = Schema.decodeUnknownOption(VividName)

/** Why the sheet is still open after Save: the name cannot be used, or the save did not land. */
type Fault = 'none' | 'name' | 'unsaved'

const FAULT_WORDS = {
  name: `Use 1 to ${VIVID_NAME_MAX} characters, without backslashes.`,
  unsaved: 'That was not saved: Vivid could not be reached. Try again.',
} satisfies Record<Exclude<Fault, 'none'>, string>

/**
 * The sheet where Vivid is given a name, a colour and a shape.
 *
 * Two references, adapted. The frame is ChatGPT's "Customize your dot" (the decompiled webview's
 * `editor-placeholder`, `appearance-picker-button` and `aeon-appearance-picker` modules): two
 * panes in a 3:2 grid, the choices on the left and, on a raised surface to the right, a large
 * name field, a large live preview and one wide Save. Kept from it: the 24-character one-line
 * name with no backslash, Enter in the name saving, a choice previewing in the big face while
 * the pointer or the keyboard is on it and selecting on click, `aria-pressed` choices, and the
 * draft staying up with an inline message when the save fails.
 *
 * The choices are Grok Bot's "Create your first Bot" step (the screenshot
 * `refs/grok-bot-screenshots/03-create-your-first-bot.png`): a row of plain colour dots with
 * the chosen one ringed, then a row of eight face outlines drawn in the chosen colour with the
 * chosen one in a ringed tile. The outlines stand where ChatGPT has "Characters". Its pets are
 * left out: they are drawn by a renderer and an account service Vivid does not have.
 *
 * Changed, and why: the groups wrap in view instead of scrolling sideways with arrow buttons,
 * because eleven dots and eight outlines fit the pane; and the first colour is the theme's own
 * accent, which is Vivid's default and moves with the theme.
 *
 * Saving is optimistic: the moment Save is pressed every face and name in the app behind the
 * sheet changes (`saveAppearance`), and the sheet closes when the server has taken it.
 */
export function Customise({ onClose }: { onClose: () => void }) {
  const saved = useAppearance()
  const me = useLiveValue(live.me)
  const [name, setName] = useState<string>(saved.name)
  const [look, setLook] = useState(saved.look)
  const [outline, setOutline] = useState(saved.outline)
  // The choice under the pointer or the keyboard, shown in the preview without being chosen.
  const [triedLook, setTriedLook] = useState<Option.Option<Look>>(Option.none())
  const [triedOutline, setTriedOutline] = useState<Option.Option<FaceOutline>>(Option.none())
  const [fault, setFault] = useState<Fault>('none')
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const faultId = useId()

  const unchanged =
    name.trim() === saved.name &&
    outline === saved.outline &&
    faceColorOf(look) === faceColorOf(saved.look)

  async function save(event: FormEvent) {
    event.preventDefault()
    const valid = decodeName(name.trim())
    if (Option.isNone(valid)) {
      setFault('name')
      if (field.current !== null) field.current.focus()
      return
    }
    setFault('none')
    setSaving(true)
    const result = await saveAppearance(new Appearance({ name: valid.value, look, outline }))
    setSaving(false)
    if (Result.isFailure(result)) setFault('unsaved')
    else onClose()
  }

  return (
    <Layer>
      <div
        role="presentation"
        className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center overscroll-contain bg-scrim p-4 backdrop-blur-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
        onKeyDown={(event) => {
          // The sheet is opened from surfaces that close on Escape themselves (the card around
          // Vivid, Settings). React carries a portal's events to them; this key is the sheet's.
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
          keepFocusInside(event)
        }}
      >
        <form
          ref={holdFocus}
          role="dialog"
          aria-modal="true"
          aria-label="Customise Vivid"
          tabIndex={-1}
          noValidate
          onSubmit={(event) => void save(event)}
          className="relative grid max-h-full w-full max-w-3xl animate-rise-in grid-cols-1 overflow-y-auto rounded-dialog bg-surface-2 lift-lg outline-none sm:h-120 sm:grid-cols-5 sm:overflow-hidden"
        >
          {/* The choices. Below the preview on a narrow window, where the preview must stay in
              view while a colour is picked. */}
          <div className="order-2 flex min-h-0 min-w-0 flex-col gap-5 p-6 sm:order-1 sm:col-span-3 sm:overflow-y-auto">
            <div>
              <h2 className="text-dialog font-title text-ink">Customise Vivid</h2>
              <p className="mt-1 text-label text-pretty text-ink-3">
                {Option.match(Option.flatMap(me, companyOf), {
                  onNone: () => 'A name, a colour and a shape, shown wherever Vivid is.',
                  onSome: (company) => `Everyone in ${company} sees this name and look.`,
                })}
              </p>
            </div>
            <Colours chosen={look} disabled={saving} onTry={setTriedLook} onChoose={setLook} />
            <Outlines
              chosen={outline}
              color={faceColorOf(look)}
              disabled={saving}
              onTry={setTriedOutline}
              onChoose={setOutline}
            />
          </div>

          {/* The result: the name, Vivid as it will look, and the one action. */}
          <div className="order-1 flex min-w-0 flex-col gap-4 bg-surface-3 px-8 pt-14 pb-8 sm:order-2 sm:col-span-2">
            <NameField
              id={nameId}
              field={field}
              value={name}
              disabled={saving}
              invalidBy={fault === 'name' ? Option.some(faultId) : Option.none()}
              onChange={(next) => {
                setName(next)
                if (fault === 'name') setFault('none')
              }}
            />
            <Preview
              color={faceColorOf(Option.getOrElse(triedLook, () => look))}
              outline={Option.getOrElse(triedOutline, () => outline)}
              name={name.trim().length > 0 ? name.trim() : 'Vivid'}
            />
            <Finish
              fault={fault}
              faultId={faultId}
              disabled={saving || unchanged}
              saving={saving}
            />
          </div>

          <div className="absolute top-3 right-3">
            <IconButton type="button" label="Close" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
        </form>
      </div>
    </Layer>
  )
}

/** What the two groups of choices share: a toggle that tries itself in the preview on the way. */
const CHOICE =
  'flex cursor-pointer items-center justify-center transition-press duration-(--dur-fast) outline-none focus-visible:ring-2 focus-visible:ring-ring active:enabled:scale-96 disabled:cursor-not-allowed disabled:opacity-60'

/** The chosen one sits on a raised fill with the accent edge; the rest take an edge on hover. */
const chosenOr = (active: boolean) =>
  active ? 'bg-surface-3 edge edge-accent' : 'hover:bg-surface-3 hover:edge'

/**
 * The colours, as plain dots (Grok Bot's row). Each is a toggle (`aria-pressed`) reached with Tab;
 * resting the pointer or the keyboard on one tries it in the preview without choosing it.
 */
function Colours({
  chosen,
  disabled,
  onTry,
  onChoose,
}: {
  chosen: Look
  disabled: boolean
  onTry: (look: Option.Option<Look>) => void
  onChoose: (look: Look) => void
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-label text-ink-3">
        Colour
      </h3>
      <div role="group" aria-labelledby={headingId} className="-mx-1 flex flex-wrap gap-0.5">
        {LOOKS.map((option) => {
          const color = faceColorOf(option)
          return (
            <button
              key={color}
              type="button"
              aria-label={lookName(option)}
              aria-pressed={color === faceColorOf(chosen)}
              title={lookName(option)}
              disabled={disabled}
              onPointerEnter={() => onTry(Option.some(option))}
              onPointerLeave={() => onTry(Option.none())}
              onFocus={() => onTry(Option.some(option))}
              onBlur={() => onTry(Option.none())}
              onClick={() => onChoose(option)}
              className={cn(CHOICE, 'size-9 rounded-full', chosenOr(color === faceColorOf(chosen)))}
            >
              <span className={cn('size-6 rounded-full', FACE_COLOR_CLASS[color])} />
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** The eight outlines, each drawn as Vivid's face in the colour that is chosen. */
function Outlines({
  chosen,
  color,
  disabled,
  onTry,
  onChoose,
}: {
  chosen: FaceOutline
  color: FaceColor
  disabled: boolean
  onTry: (outline: Option.Option<FaceOutline>) => void
  onChoose: (outline: FaceOutline) => void
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-label text-ink-3">
        Shape
      </h3>
      <div role="group" aria-labelledby={headingId} className="-mx-1 grid grid-cols-4 gap-1">
        {FaceOutline.literals.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={outlineName(option)}
            aria-pressed={option === chosen}
            title={outlineName(option)}
            disabled={disabled}
            onPointerEnter={() => onTry(Option.some(option))}
            onPointerLeave={() => onTry(Option.none())}
            onFocus={() => onTry(Option.some(option))}
            onBlur={() => onTry(Option.none())}
            onClick={() => onChoose(option)}
            className={cn(CHOICE, 'h-20 rounded-card', chosenOr(option === chosen))}
          >
            <span className="pointer-events-none">
              <Face color={color} outline={option} size={48} label="" />
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * The name, large and centred as the reference draws it. It is one line of at most 24 characters;
 * the label is for a screen reader, because the sheet's own title already says what is named.
 */
function NameField({
  id,
  field,
  value,
  disabled,
  invalidBy,
  onChange,
}: {
  id: string
  field: RefObject<HTMLInputElement | null>
  value: string
  disabled: boolean
  /** The id of the message that says why the name cannot be used, while it cannot. */
  invalidBy: Option.Option<string>
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="sr-only">
        Name
      </label>
      <input
        id={id}
        ref={field}
        name="name"
        // The sheet exists to take this answer; the reference puts the cursor here too.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={value}
        maxLength={VIVID_NAME_MAX}
        placeholder="Vivid"
        disabled={disabled}
        aria-invalid={Option.isSome(invalidBy)}
        aria-describedby={Option.getOrUndefined(invalidBy)}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-14 w-full rounded-control bg-well px-3 text-center font-display text-section font-strong text-ink edge outline-none edge-field placeholder:text-ink-3 focus-visible:edge-accent disabled:opacity-60"
      />
    </div>
  )
}

/**
 * Vivid as it will look. Not a control: it only looks back. It leans in under the pointer and
 * leans away while pressed, which are the face's own moods (`@vivid/marks`); the tilt and the
 * colour ease across in `styles/vivid.css`, once per change, and not at all under reduced motion.
 */
function Preview({
  color,
  outline,
  name,
}: {
  color: FaceColor
  outline: FaceOutline
  name: string
}) {
  const [mood, setMood] = useState<FaceMood>('neutral')
  return (
    <div data-vivid-preview className="flex min-h-48 flex-1 items-center justify-center">
      <span
        className="inline-flex"
        onPointerEnter={() => setMood('happy')}
        onPointerLeave={() => setMood('neutral')}
        onPointerDown={() => setMood('thinking')}
        onPointerUp={() => setMood('happy')}
      >
        <Face
          color={color}
          outline={outline}
          size={184}
          mood={mood}
          label={`${name}, as it will look`}
        />
      </span>
    </div>
  )
}

/** The end of the sheet: why it is still open, when it is, and the one wide action. */
function Finish({
  fault,
  faultId,
  disabled,
  saving,
}: {
  fault: Fault
  faultId: string
  disabled: boolean
  saving: boolean
}) {
  return (
    <div className="flex flex-col gap-3">
      {fault !== 'none' && (
        <p id={faultId} role="alert" className="text-center text-label text-danger">
          {FAULT_WORDS[fault]}
        </p>
      )}
      {/* The reference's one wide action. `Button` has no full-width pill, so this is the
          primary variant's own colours on a native button, not a restyled component. */}
      <button
        type="submit"
        disabled={disabled}
        className="flex h-10 w-full cursor-pointer items-center justify-center rounded-full bg-accent text-title font-title text-ink-on-accent transition-press duration-(--dur-fast) outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-3 active:enabled:scale-96 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}
