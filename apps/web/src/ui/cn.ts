import { createCn } from 'cn/config'

/**
 * Joins class names and settles conflicts between them, so a caller's class replaces the
 * component's own instead of both reaching the element and the stylesheet's order deciding.
 *
 * It is shadcn's `cn` engine (the successor to `clsx` + `tailwind-merge`), told about Vivid's
 * theme. Without that it reads `text-label` as a colour, because it does not know the name, and
 * drops it whenever a real text colour follows. Every name here is declared in the `@theme inline`
 * block of `packages/design/tokens/src/tokens.css` or as an `@utility` in `styles/index.css`;
 * a name added there is added here.
 */
export const cn = createCn({
  extend: {
    theme: {
      text: [
        'meta',
        'label',
        'title',
        'body',
        'dialog',
        'section',
        'page',
        'hero',
        'display',
        'inline-code',
      ],
      'font-weight': ['meta', 'title', 'strong'],
      radius: ['row', 'control', 'card', 'panel', 'dialog', 'composer'],
      tracking: ['display', 'caps'],
      blur: ['scrim'],
      container: ['bubble', 'rail-label'],
    },
    classGroups: {
      // A layer's edge and a floating layer's lift are box-shadows, so they replace one another
      // and any `shadow-*` a component declared.
      shadow: ['edge', 'lift', 'lift-lg', 'ring-line'],
    },
  },
})
