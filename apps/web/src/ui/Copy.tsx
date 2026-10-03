import { Check, Copy as CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from './Button'

/** What the button says for each thing that can have happened to the last click. */
const LABEL = {
  idle: 'Copy',
  copied: 'Copied',
  refused: 'Copy it by hand',
} satisfies Record<'idle' | 'copied' | 'refused', string>

/**
 * Copies one value to the clipboard and says whether it worked.
 *
 * The value is read from the caller only when the button is pressed, so a secret is not held here
 * between renders. The browser can refuse the clipboard (no permission, an insecure origin); that
 * is said on the button instead of being swallowed, because the Person must then select the text.
 */
export function Copy({ name, read }: { name: string; read: () => string }) {
  const [state, setState] = useState<keyof typeof LABEL>('idle')
  return (
    <Button
      type="button"
      size="sm"
      aria-label={`${LABEL[state]}: ${name}`}
      icon={state === 'copied' ? <Check className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      onClick={() => {
        // Over plain http from another machine the browser has no clipboard at all, and reaching
        // for it throws before there is a promise to refuse.
        if (!('clipboard' in navigator)) {
          setState('refused')
          return
        }
        void navigator.clipboard.writeText(read()).then(
          () => setState('copied'),
          () => setState('refused'),
        )
      }}
    >
      {LABEL[state]}
    </Button>
  )
}
