---
name: animation-gallery
description: Curated, buildable motion patterns for Vivid on React web and Expo. Use when choosing or implementing a named animation effect and you need exact values, CSS-first web code, Reanimated code, interruption, reduced-motion, and performance guidance. Use animation-vocabulary first when the effect has not been named.
---

# Animation Gallery

A small catalogue of motion Vivid will actually use. It is an implementation reference, not permission to animate. First apply the frequency and purpose gate from `animate` or `animate-expo`; use `review-animations` after implementation.

## Use it

1. Name the effect with `animation-vocabulary`; do not invent a synonym.
2. Pass the gate: **feedback**, **spatial consistency**, **state indication**, or **preventing a jarring change**. Explanation/delight is rare-only.
3. Open one family below and start from its values and code. CSS is the web default; Motion is optional and not installed.
4. Preserve interruption, exit, reduced-motion, and performance behavior from the entry.
5. Feel-check at 2–5× speed; test gestures in a release build on the slowest supported phone.

## Vivid baseline

Use existing `packages/design/tokens/src/tokens.css`; do not fork it:

```css
--dur-fast: 120ms;
--dur-base: 200ms;
--dur-slow: 320ms; /* ambient/rare only; not interactive UI */
--ease-out: cubic-bezier(0.2, 0, 0, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
```

- Enter with `--ease-out`; move an already-visible object with `--ease-in-out`; constant progress is `linear`. Never use `ease-in`.
- Animate `transform` and `opacity`. `clip-path` is acceptable for reveals. Layout animation is an explicit exception.
- Start entrances at `scale(.95–.97)`, never `scale(0)`. Triggered surfaces use the trigger origin; dialogs stay centered.
- Reduced motion keeps opacity/color, removes translation, scale, parallax, overshoot, and automatic loops.
- Keyboard actions and 100+/day interactions change instantly. Frequent feedback is ≤150ms.
- Web examples assume React 19 + Tailwind v4 + CSS. Motion examples use `motion/react` only where CSS cannot provide gestures, shared layout, or velocity-preserving springs.
- Expo examples assume Reanimated 4.5, Gesture Handler 2.32, and `expo-haptics`; shared values stay on the UI thread and use `.get()`/`.set()`.

## Spring presets

The design and physics forms below are practical perceptual matches, not numerically identical solvers. Physics damping is chosen from `c = 2ζ√(km)`; always pass gesture velocity.

| Preset | Motion design form | Physics form (`mass`, `stiffness`, `damping`) | Reanimated duration form | Use |
| --- | --- | --- | --- | --- |
| **S0 settle** | `visualDuration: .4, bounce: 0` | `1, 170, 26` | `duration: 400, dampingRatio: 1` | layout/shared element, snap-back |
| **S1 momentum** | `visualDuration: .4, bounce: .2` | `1, 200, 22.6` | `duration: 400, dampingRatio: .8` | flick/reorder/drop |
| **S2 sheet** | `visualDuration: .3, bounce: .2` | `1, 300, 27.7` | `duration: 300, dampingRatio: .8` | sheet/drawer settle |

Motion's duration/bounce spring does not preserve velocity; for a gesture use the physics form. Reanimated accepts either physics or duration/damping-ratio form, not both in one config.

## Budget

| Frequency | Maximum | Vivid examples |
| --- | ---: | --- |
| 100+/day or keyboard | `0ms` | command menu, focus jump, tab switch |
| Tens/day | `120–150ms` | press, hover/color, row affordance |
| Occasional small surface | `200ms` | tooltip, popover, card state |
| Occasional large surface | `250ms` or **S2** | panel, toast, sheet; native navigation keeps platform timing |
| Rare/ambient | `320ms`; loops ≥`1200ms` | onboarding entrance, passive working pulse |

`--dur-slow` is 320ms, so reserve it for non-blocking rare/ambient motion. This resolves the repository's “UI under 300ms” rule without changing the token.

## Pairing

| Entrance | Exit | Press feedback | Mobile haptic |
| --- | --- | --- | --- |
| Fade in `200ms` | Fade out `120ms` | none | none |
| Scale in `.96`, `200ms` | Scale out `.98`, `120ms` | `scale(.96)`, `120ms` | none |
| Slide in `8px`, `200ms` | same edge, `120ms` | none | none |
| Toast from bottom `250ms` | bottom `200ms` | swipe follows finger | light impact only when it snaps/commits |
| Hold to confirm `2s linear` | reset `200ms` | `scale(.96)`, `120ms` | medium impact at commit |
| Segmented selection `200ms` | reverse from current value | `scale(.98)`, `120ms` | selection at state change |

One haptic per user action, on the causal frame, never as the only feedback.

## Families and entries

| Family | Entries |
| --- | --- |
| [Entrances & exits](references/entrances-exits.md) | Fade in / Fade out; Scale in; Slide in; Pop in; Reveal |
| [Sequencing](references/sequencing.md) | Keyframes; Stagger; Orchestration |
| [Transforms](references/transforms.md) | Translate; Scale; Transform origin; Origin-aware animation |
| [State transitions](references/state-transitions-shared-element.md) | Crossfade; Continuity transition; Morph; Shared element transition; Accordion / Collapse; Direction-aware transition |
| Scroll (recipe not yet catalogued) | Scroll reveal; Scroll-driven animation; Page transition; View transition |
| Feedback & press (recipe not yet catalogued) | Hover effect; Press / Tap feedback; Hold to confirm; Shake / Wiggle |
| Easing & springs (recipe not yet catalogued) | Easing; Ease-out; Ease-in-out; Spring; Interruptible animation |
| Looping & ambient (recipe not yet catalogued) | Loop; Pulse; Idle animation |
| Gestures & sheets (recipe not yet catalogued) | Drag; Swipe to dismiss; Rubber-banding; Momentum |
| Streaming text & lists (recipe not yet catalogued) | Typewriter; Text morph; Enter / Exit; Layout animation |
| Loading (recipe not yet catalogued) | Skeleton / Shimmer; Linear; Pulse; Crossfade |

Open linked families for bundled recipes. For vocabulary-only families, apply `animate` or `animate-expo` before implementation.

## Source policy

Primary, inspectable sources outrank summaries: [Emil Kowalski](https://emilkowal.ski/ui/great-animations), [Sonner](https://emilkowal.ski/ui/building-a-toast-component), [Vaul](https://emilkowal.ski/ui/building-a-drawer-component), [Motion docs/examples](https://motion.dev/examples), [Rauno Freiberg](https://rauno.me/craft/interaction-design), [Apple WWDC18](https://developer.apple.com/videos/play/wwdc2018/803/), [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Material 3 tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs), [Reanimated](https://docs.swmansion.com/react-native-reanimated/docs/animations/withSpring/), [Gesture Handler](https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/gesture-animation/), [MDN View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using), and [CSS `linear()`](https://developer.chrome.com/docs/css-ui/css-linear-easing-function).

Public skill catalogues including [joepUI/motion-ref-skill](https://github.com/joepui/motion-ref-skill), [LottieFiles/motion-design-skill](https://github.com/lottiefiles/motion-design-skill), and [Rune motion craft](https://github.com/rune-kit/rune/blob/master/skills/design/MOTION-CRAFT.md) were checked for catalogue structure. Their unsourced values are not authority here.

## Deliberate disagreements

- Emil's strong curve is `cubic-bezier(.23,1,.32,1)`; Vivid already owns Material Standard `cubic-bezier(.2,0,0,1)`. The gallery uses Vivid's token to keep one source of truth.
- Vaul uses `500ms` for iOS-like web sheets; Vivid uses **S2** (~300ms perceived) because this is a frequent product surface and the local rule is under 300ms. Native `formSheet` keeps platform timing.
- Sonner uses `400ms ease`; Vivid caps toast entry at `250ms` and exit at `200ms` because notifications are uninvited and the product is calm, dense, and frequently used.
- Material offers 50–1000ms taxonomy; Vivid adopts only its short/medium classification. Long expressive values are excluded from product UI.
- Reanimated's documented duration spring is actually 1.5× its perceptual duration. Tables state perceptual values and never mix the mutually exclusive spring config forms.

## Do not choose from this gallery

No parallax in daily product screens; no marquee, orbit, decorative float, 3D flip, ripple, or bounce without gesture momentum. Do not animate streaming text already present in history, virtualized rows on mount, tab navigation, keyboard-triggered UI, or data the person is actively reading.
