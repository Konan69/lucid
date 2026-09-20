# Sequencing & timing

Sequence only small, finite groups. Content must be interactive immediately; never make the person wait for decoration.

## **Keyframes** · a fixed multi-stage cue plays the same way each time

- **Use in Vivid for:** spinner rotation and a rare status error wiggle. **Do not use for:** toasts, toggles, gestures, or any rapidly retriggered state.
- **Values:** 2–4 frames; UI cue `200ms`; ambient loop ≥`1200ms`; easing per segment; transform origin center.
- **Web — CSS first:** `@keyframes spin{to{transform:rotate(1turn)}} .spinner{animation:spin 800ms linear infinite}`; fixed, autonomous motion is the correct keyframe use.
- **Web — Motion:** Not needed. Keyframe arrays are allowed only when runtime coordination is essential.
- **Expo — Reanimated:** use a module-scope `Keyframe` or `withRepeat(withTiming(1,{duration:800,easing:Easing.linear}),-1)`; keep it on the UI thread.
- **Interruption & exit:** stop loops immediately when state ends; keyframes restart, so never use them where retargeting matters. **Reduced motion:** replace loops with a static icon + status label.
- **Performance note:** transform/opacity only; do not leave `will-change` or infinite work active while hidden.
- **Modelled on:** [MDN keyframes](https://developer.mozilla.org/en-US/docs/Web/CSS/@keyframes), [Reanimated keyframes](https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/keyframe-animations/), [Sonner interruption analysis](https://emilkowal.ski/ui/building-a-toast-component).

## **Stagger** · a small group arrives as a quick cascade

- **Use in Vivid for:** first-run suggestion cards or a newly requested, non-virtualized result group. **Do not use for:** thread history, Today rows, sidebar lists, or more than 6 items.
- **Values:** each item `200ms`, `translateY(6px)→0`, opacity `0→1`, gap `40ms`, max 6, `var(--ease-out)`, top origin.
- **Web — CSS first:** `.item{animation:rise 200ms var(--ease-out) both;animation-delay:calc(var(--i)*40ms)} @keyframes rise{from{opacity:0;transform:translateY(6px)}}`.
- **Web — Motion:** only for dynamic child count: parent `transition:{delayChildren:stagger(.04)}`; children use a full transform string.
- **Expo — Reanimated:** `FadeInDown.duration(200).delay(Math.min(index,5)*40).reduceMotion(System)` memoized per row; never on `FlatList` rows.
- **Interruption & exit:** cancellation reveals all remaining items immediately; group exit is a single `120ms` fade, not reverse stagger. **Reduced motion:** simultaneous `200ms` opacity.
- **Performance note:** cap DOM/native nodes; stagger must not delay hit testing or list virtualization.
- **Modelled on:** [Emil—stagger](https://emilkowal.ski/ui/great-animations), [Motion orchestration](https://motion.dev/docs/react-transitions#orchestration), [Reanimated entering/exiting](https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/entering-exiting-animations/).

## **Orchestration** · related parts move in one ordered beat

- **Use in Vivid for:** open panel: scrim first frame, panel immediately, panel content after `40ms`; connection success: state mark then label. **Do not use for:** independent controls or long cinematic chains.
- **Values:** total ≤`250ms`; parent `200–250ms`; child delay `40ms`; no more than 2 phases; `var(--ease-out)`; no scale below `.96`.
- **Web — CSS first:** give descendants `transition-delay:40ms`; remove delay on close so response is immediate.
- **Web — Motion:** when parent/child mount order is dynamic, variants use `when:"beforeChildren"` and `delayChildren:.04`; do not use for a static two-phase CSS sequence.
- **Expo — Reanimated:** `withDelay(40,withTiming(...,{duration:200,easing:EASE_OUT,reduceMotion:System}),ReduceMotion.System)`; never `scheduleOnRN` for visual phases.
- **Interruption & exit:** a close cancels delays and sends every part to exit now. **Reduced motion:** remove delays; use one simultaneous opacity change.
- **Performance note:** all phases transform/opacity; delays do not justify extra React state.
- **Modelled on:** [Rauno—Designing Depth/choreography](https://rauno.me/craft/depth), [Motion orchestration](https://motion.dev/docs/react-transitions#orchestration), [Reanimated accessibility](https://docs.swmansion.com/react-native-reanimated/docs/guides/accessibility/).

## **Stepped animation** · progress advances in discrete, readable states

- **Use in Vivid for:** bounded upload phases or a countdown with tabular numbers. **Do not use for:** model work where progress is unknowable, or fake percentages.
- **Values:** state change `120ms` opacity/color; numeric steps at the real event cadence; no translate/scale; `steps(1,end)` only when the underlying data is discrete.
- **Web — CSS first:** `.phase{transition:opacity var(--dur-fast) var(--ease-out)}`; for an honest fixed countdown, `animation-timing-function:steps(1,end)` and `font-variant-numeric:tabular-nums`.
- **Web — Motion:** Not needed; update semantic state from real progress events.
- **Expo — Reanimated:** `withTiming(next,{duration:120,easing:EASE_OUT,reduceMotion:System})` for an indicator; text changes atomically and uses tabular figures.
- **Interruption & exit:** jump to the latest true state; never replay missed steps. **Reduced motion:** instant number/state plus `120ms` color if helpful.
- **Performance note:** do not schedule frame-level React updates; one update per domain event.
- **Modelled on:** [MDN `steps()`](https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/steps), [Material duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs), [Vivid design language](../../../../DESIGN.md).
