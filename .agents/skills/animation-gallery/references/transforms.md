# Movement & transforms

Transforms explain geometry; they do not decorate dense product UI.

## **Translate** · an object moves a short, spatially meaningful distance

- **Use in Vivid for:** panel edge travel, chevron nudge, selected-tab indicator. **Do not use for:** text, repeated navigation, or arbitrary drift.
- **Values:** micro `2px/120ms`; entrance `6–16px/200–250ms`; full dismissal `100%`; `var(--ease-out)` entering, `var(--ease-in-out)` while on-screen; origin follows edge.
- **Web — CSS first:** `.chevron{transition:transform var(--dur-fast) var(--ease-out)} .row:hover .chevron{transform:translateX(2px)}` inside fine-pointer hover media.
- **Web — Motion:** only for velocity/drag; animate a full `transform` string or MotionValue, not React state.
- **Expo — Reanimated:** derive `transform:[{translateX:x.get()}]` in `useAnimatedStyle`; `withTiming` for state, spring + release velocity for gesture.
- **Interruption & exit:** transitions/springs start from current transform; return along the same axis. **Reduced motion:** `translate=0`, retain opacity/color.
- **Performance note:** compositor/UI-thread property; set transform on the moving node, not a parent CSS variable.
- **Modelled on:** [Emil—Great Animations](https://emilkowal.ski/ui/great-animations), [Vaul performance](https://emilkowal.ski/ui/building-a-drawer-component), [Reanimated gesture handling](https://docs.swmansion.com/react-native-reanimated/docs/fundamentals/handling-gestures/).

## **Scale** · an object's size changes just enough to communicate pressure or continuity

- **Use in Vivid for:** press feedback and compact surface entry. **Do not use for:** page zoom, data cards on hover, or any entrance from zero.
- **Values:** press `.96` web / `.97` mobile over `120ms`; entrance `.96→1` over `200ms`; origin trigger/press point where possible.
- **Web — CSS first:** `.press{transition:transform var(--dur-fast) var(--ease-out)} .press:active{transform:scale(.96)}`.
- **Web — Motion:** Not needed for a two-state press; use only when scale is part of a shared or gesture-driven transform.
- **Expo — Reanimated:** Reanimated CSS transition `transform:[{scale:pressed?.97:1}]`, `transitionDuration:"120ms"`, timing `cubic-bezier(.2,0,0,1)`.
- **Interruption & exit:** release retargets immediately to `1`; never wait for press-in to finish. **Reduced motion:** opacity/background feedback, no scale.
- **Performance note:** transform is cheap but scales children; keep delta small to preserve type crispness.
- **Modelled on:** [Emil—7 Practical Animation Tips](https://emilkowal.ski/ui/7-practical-animation-tips), [Apple fluid response](https://developer.apple.com/videos/play/wwdc2018/803/), [Reanimated CSS transitions](https://docs.swmansion.com/react-native-reanimated/docs/css-animations/transition/).

## **Transform origin** · motion pivots around the point that physically owns it

- **Use in Vivid for:** menu/popover trigger edge, disclosure chevron, attachment preview anchor. **Do not use for:** centered dialogs or full-screen routes.
- **Values:** popover uses runtime trigger coordinates; chevron center; scale `.96→1`, `200ms`; no distance/stagger.
- **Web — CSS first:** `.popover{transform-origin:var(--transform-origin);transition:transform 200ms var(--ease-out),opacity 200ms var(--ease-out)}`.
- **Web — Motion:** Not needed; preserve the primitive's computed origin. For shared layout, let `layoutId` provide continuity instead of guessing an origin.
- **Expo — Reanimated:** RN transforms pivot around center; emulate a top-left origin with translate-to-origin → scale → translate-back, measured once with `onLayout`, or prefer a native sheet.
- **Interruption & exit:** reverse around the same origin. **Reduced motion:** opacity only, so origin becomes irrelevant.
- **Performance note:** measuring once is fine; never measure every frame or read layout on the JS thread during a gesture.
- **Modelled on:** [Emil—origin-aware popovers](https://emilkowal.ski/ui/great-animations), [Base UI transitions](https://base-ui.com/react/overview/transitions), [React Native transforms](https://reactnative.dev/Docs/transforms).

## **Origin-aware animation** · a surface visibly comes from the control that opened it

- **Use in Vivid for:** card action menu, connection picker, attachment/tool popover. **Do not use for:** modal tasks, command menu, or keyboard-triggered UI.
- **Values:** `scale(.96)+opacity(0)→1`, `200ms var(--ease-out)`, trigger-side origin; exit `.98+opacity(0)`, `120ms`; no stagger.
- **Web — CSS first:** use the headless primitive's `--transform-origin` and `data-starting-style`/`data-ending-style`; never calculate center manually when the primitive provides it.
- **Web — Motion:** only if the source and destination are separate live nodes; use `layoutId` + **S0**: physics `1/170/26`, design `.4s/bounce 0`.
- **Expo — Reanimated:** use native `formSheet` for sheet-like origins; custom anchored overlays use measured pivot plus `withTiming(...200ms)`, not a spring.
- **Interruption & exit:** close from current state toward the trigger; rapid reopen retargets. **Reduced motion:** `200ms` opacity without scale/translation.
- **Performance note:** transform + opacity; keep trigger and overlay geometry stable during the transition.
- **Modelled on:** [Emil—7 Practical Animation Tips](https://emilkowal.ski/ui/7-practical-animation-tips), [Motion layout](https://motion.dev/docs/react-layout-animations), [Apple spatial consistency](https://developer.apple.com/videos/play/wwdc2018/803/).
