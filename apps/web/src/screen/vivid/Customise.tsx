import {
  Appearance,
  FaceHue,
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
import { Face, type FaceColor, type FaceMood } from '../../ui/Face'
import { holdFocus, keepFocusInside, Layer } from '../../ui/Layer'

/** Every look there is to choose, in the order they are shown: the theme's own colour first. */
const LOOKS: ReadonlyArray<Look> = [
  Look.cases.Accent.make({}),
  ...FaceHue.literals.map((hue) => Look.cases.Hue.make({ hue })),
]

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
 * The sheet where Vivid is given a name and a colour.
 *
 * Adapted from ChatGPT's "Customize your dot" (the decompiled webview's `editor-placeholder`,
 * `appearance-picker-button` and `aeon-appearance-picker` modules): two panes in a 3:2 grid, the
 * choices on the left and, on a quieter surface to the right, a large name field, a large live
 * preview and one wide Save. Kept from it: the 24-character one-line name with no backslash,
 * Enter in the name saving, a swatch previewing in the big face while the pointer or the keyboard
 * is on it and selecting on click, `aria-pressed` swatches, and the draft staying up with an
 * inline message when the save fails.
 *
 * Changed, and why: the reference has three scrolling rows (colours, characters, pets). Its
 * characters and pets are drawn by a renderer and an account service Vivid does not have, so
 * there is one group here and it is laid out as the reference's own grid variant
 * (`grid grid-cols-3 md:grid-cols-4`) instead of a single scrolling row with arrows: eleven
 * colours fit in view, and a lone row would leave the pane empty beneath it. Each swatch draws
 * Vivid's face in that colour, where the reference shows a plain tinted ring.
 *
 * Saving is optimistic: the moment Save is pressed every face and name in the app behind the
 * sheet changes (`saveAppearance`), and the sheet closes when the server has taken it.
 */
export function Customise({ onClose }: { onClose: () => void }) {
  const saved = useAppearance()
  const me = useLiveValue(live.me)
  const [name, setName] = useState<string>(saved.name)
  const [look, setLook] = useState(saved.look)
  // The swatch under the pointer or the keyboard, shown in the preview without being chosen.
  const [tried, setTried] = useState<Option.Option<Look>>(Option.none())
  const [fault, setFault] = useState<Fault>('none')
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const faultId = useId()

  const chosen = faceColorOf(look)
  const unchanged = name.trim() === saved.name && chosen === faceColorOf(saved.look)
  const shared = Option.flatMap(me, companyOf)

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
    const result = await saveAppearance(new Appearance({ name: valid.value, look }))
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
          className="relative grid max-h-full w-full max-w-3xl animate-rise-in grid-cols-1 overflow-y-auto rounded-dialog bg-surface-3 lift-lg outline-none sm:h-120 sm:grid-cols-5 sm:overflow-hidden"
        >
          {/* The choices. Below the preview on a narrow window, where the preview must stay in
              view while a colour is picked. */}
          <div className="order-2 flex min-h-0 min-w-0 flex-col gap-4 p-6 sm:order-1 sm:col-span-3 sm:overflow-y-auto">
            <div>
              <h2 className="text-dialog font-title text-ink">Customise Vivid</h2>
              <p className="mt-1 text-label text-pretty text-ink-3">
                {Option.match(shared, {
                  onNone: () => 'A name and a colour, shown wherever Vivid is.',
                  onSome: (company) => `Everyone in ${company} sees this name and colour.`,
                })}
              </p>
            </div>
            <section aria-labelledby={`${nameId}-colours`} className="flex flex-col gap-2">
              <h3 id={`${nameId}-colours`} className="text-label text-ink-3">
                Colours
              </h3>
              <Swatches chosen={chosen} disabled={saving} onTry={setTried} onChoose={setLook} />
            </section>
          </div>

          {/* The result: the name, Vivid as it will look, and the one action. */}
          <div className="order-1 flex min-w-0 flex-col gap-4 bg-surface-2 px-8 pt-14 pb-8 hairline-b sm:order-2 sm:col-span-2 sm:border-b-0">
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
              color={faceColorOf(Option.getOrElse(tried, () => look))}
              name={name.trim().length > 0 ? name.trim() : 'Vivid'}
            />
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
                disabled={saving || unchanged}
                className="h-10 w-full cursor-pointer rounded-full bg-accent text-title font-title text-ink-on-accent transition-press duration-(--dur-fast) outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-2 active:enabled:scale-96 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
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

/**
 * The colours, as faces. Each is a toggle (`aria-pressed`), reached with Tab like the reference's
 * swatches; resting the pointer or the keyboard on one tries it in the preview without choosing.
 */
function Swatches({
  chosen,
  disabled,
  onTry,
  onChoose,
}: {
  chosen: FaceColor
  disabled: boolean
  onTry: (look: Option.Option<Look>) => void
  onChoose: (look: Look) => void
}) {
  return (
    <div role="group" className="-mx-2 grid grid-cols-4 gap-1">
      {LOOKS.map((option) => {
        const color = faceColorOf(option)
        const active = color === chosen
        return (
          <button
            key={color}
            type="button"
            aria-label={lookName(option)}
            aria-pressed={active}
            title={lookName(option)}
            disabled={disabled}
            onPointerEnter={() => onTry(Option.some(option))}
            onPointerLeave={() => onTry(Option.none())}
            onFocus={() => onTry(Option.some(option))}
            onBlur={() => onTry(Option.none())}
            onClick={() => onChoose(option)}
            className={cn(
              'flex aspect-square cursor-pointer items-center justify-center rounded-card transition-press duration-(--dur-fast) outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-96 disabled:cursor-not-allowed disabled:opacity-60',
              active ? 'bg-surface-2 ring-2 ring-ink ring-inset' : 'hover:bg-wash-hover',
            )}
          >
            <span data-face-fixed="swatch" className="pointer-events-none">
              <Face color={color} size={56} label="" />
            </span>
          </button>
        )
      })}
    </div>
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
function Preview({ color, name }: { color: FaceColor; name: string }) {
  const [mood, setMood] = useState<FaceMood>('neutral')
  return (
    <div data-face-fixed="preview" className="flex min-h-40 flex-1 items-center justify-center">
      <span
        className="inline-flex rounded-full"
        onPointerEnter={() => setMood('happy')}
        onPointerLeave={() => setMood('neutral')}
        onPointerDown={() => setMood('thinking')}
        onPointerUp={() => setMood('happy')}
      >
        <Face color={color} size={160} mood={mood} label={`${name}, as it will look`} />
      </span>
    </div>
  )
}
