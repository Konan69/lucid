# Entrances & exits

Only animate an arrival the person requested or an occasional surface. Existing thread history and keyboard-opened UI appear instantly.

## **Fade in / Fade out** · content becomes present or absent without moving

- **Use in Vivid for:** panel scrims, connection-state swaps, reduced-motion fallbacks. **Do not use for:** every message or historical row.
- **Values:** enter `200ms var(--ease-out)`, exit `120ms var(--ease-out)`, opacity `0→1`; no distance, scale, stagger, or origin.
- **Web — CSS first:** `.fade{transition:opacity var(--dur-base) var(--ease-out)} .fade[data-closed]{opacity:0}`; use `@starting-style{.fade{opacity:0}}` for mount.
- **Web — Motion:** Not needed; use `AnimatePresence` only when React must keep an exiting node mounted: `initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}`.
- **Expo — Reanimated:** `entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}` and `exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}`; builders live at module scope.
- **Interruption & exit:** A transition retargets from current opacity; exit is faster. **Reduced motion:** unchanged—opacity is the fallback.
- **Performance note:** opacity is compositor-friendly; avoid fading whole text columns during reading.
- **Modelled on:** [Vivid tokens](../../../design-tokens/src/tokens.css), [Emil—Great Animations](https://emilkowal.ski/ui/great-animations), [Reanimated entering/exiting](https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/entering-exiting-animations/).

## **Scale in** · a compact surface grows the last few percent into place

- **Use in Vivid for:** approval detail popovers, contextual cards, centered dialogs. **Do not use for:** full screens, thread rows, or `scale(0)` effects.
- **Values:** enter `200ms`, exit `120ms`, `scale(.96)→1`, opacity `0→1`, `var(--ease-out)`; origin trigger-side, except dialogs use center.
- **Web — CSS first:** `.surface{transition:transform 200ms var(--ease-out),opacity 200ms var(--ease-out)} .surface[data-closed]{transform:scale(.96);opacity:0}`.
- **Web — Motion:** Not needed unless exit mounting is unavailable; then use full `transform: "scale(.96)"`, not the `scale` shorthand.
- **Expo — Reanimated:** custom entering animation: `initialValues:{opacity:0,transform:[{scale:.96}]}` → `withTiming(1,{duration:200,easing:EASE_OUT,reduceMotion:System})`; exit uses `120ms` to `.98` + opacity `0`.
- **Interruption & exit:** transition/timing reverses from the visible value; never queue. **Reduced motion:** opacity only, no scale.
- **Performance note:** transform + opacity only; scaling text is acceptable over this small delta.
- **Modelled on:** [Emil—7 Practical Animation Tips](https://emilkowal.ski/ui/7-practical-animation-tips), [Base UI transitions](https://base-ui.com/react/overview/transitions), [Apple accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility).

## **Slide in** · a surface arrives from the edge where it lives

- **Use in Vivid for:** the on-demand side panel and bottom toast. **Do not use for:** tabs, assistant text, or a panel with no spatial edge.
- **Values:** panel `translateX(16px)→0`; toast `translateY(100%)→0`; enter `250ms`, exit `200ms`, opacity `0→1`, `var(--ease-out)`; edge-facing origin.
- **Web — CSS first:** `.panel{transition:transform 250ms var(--ease-out),opacity 200ms var(--ease-out)} .panel[data-closed]{transform:translateX(16px);opacity:0}`; toast uses `translateY(100%)`.
- **Web — Motion:** Not needed for button-controlled panels. Use Motion only if drag must hand off velocity.
- **Expo — Reanimated:** `withTiming(0,{duration:250,easing:EASE_OUT,reduceMotion:System})` on a shared `translateX`; native stack owns screen slides.
- **Interruption & exit:** leave through the same edge in `200ms`; transitions retarget. **Reduced motion:** opacity `200ms`, translation fixed at `0`.
- **Performance note:** transform + opacity; percentages adapt to toast height. Keep side-panel DOM mounted if toggled often.
- **Modelled on:** [Apple—Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/), [Emil—You Don't Need Animations](https://emilkowal.ski/ui/you-dont-need-animations), [Expo Router animations](https://docs.expo.dev/router/advanced/stack/#animation).

## **Pop in** · a rare success arrives with one restrained overshoot

- **Use in Vivid for:** first successful connection or a rare completed setup. **Do not use for:** approvals, errors, routine runs, toasts, or repeated status changes.
- **Values:** `scale(.95)→1`; opacity `0→1`; **S1 momentum** only: physics `mass:1, stiffness:200, damping:22.6`; design `visualDuration:.4, bounce:.2`; Expo duration form `400ms, dampingRatio:.8`; center origin.
- **Web — CSS first:** for a predetermined rare cue, `transition:transform 320ms var(--ease-out),opacity 200ms var(--ease-out)` without overshoot.
- **Web — Motion:** spring version: `transition={{type:"spring",stiffness:200,damping:22.6,mass:1}}`; use the design form only when no velocity exists.
- **Expo — Reanimated:** `scale.set(withSpring(1,{stiffness:200,damping:22.6,mass:1,reduceMotion:ReduceMotion.System}))`; pair a success haptic only when a user action caused it.
- **Interruption & exit:** retarget the spring from current scale; exit is a non-bouncy `120ms` fade/`.98`. **Reduced motion:** `200ms` opacity only, no haptic change.
- **Performance note:** one element, transform + opacity; never mount a confetti field for this pattern.
- **Modelled on:** [Motion spring options](https://motion.dev/docs/react-transitions#spring), [Apple fluid interfaces](https://developer.apple.com/videos/play/wwdc2018/803/), [Expo Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/).

## **Reveal** · content is uncovered from an edge rather than moved

- **Use in Vivid for:** a one-time attachment preview or rare onboarding illustration. **Do not use for:** thread text, routine cards, or repeatedly opened UI.
- **Values:** `clip-path:inset(0 0 100% 0)→inset(0)`, `320ms var(--ease-in-out)`; no scale; origin top; no stagger.
- **Web — CSS first:** `.reveal{clip-path:inset(0);transition:clip-path var(--dur-slow) var(--ease-in-out)} @starting-style{.reveal{clip-path:inset(0 0 100% 0)}}`.
- **Web — Motion:** Not needed; WAAPI is enough for programmatic playback and cancellation.
- **Expo — Reanimated:** React Native has no general `clip-path`; reveal with an `overflow:"hidden"` wrapper and translate the child `-8→0` plus opacity over `320ms`, or use a static appearance when masking would require Skia.
- **Interruption & exit:** cancel/retarget WAAPI; exit reverses the same edge in `200ms`. **Reduced motion:** opacity `200ms`, no wipe.
- **Performance note:** `clip-path` may paint; keep area small. The Expo fallback stays compositor-friendly.
- **Modelled on:** [Emil recipes—clip-path reveal](../../animate/RECIPES.md), [MDN clip-path](https://developer.mozilla.org/en-US/docs/Web/CSS/clip-path), [Apple accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility).
