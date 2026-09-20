# State transitions & shared elements

Use continuity when it helps the person track identity. If the same content merely updates, change it in place.

## **Crossfade** · old and new states overlap briefly in the same footprint

- **Use in Vivid for:** send↔stop icon, connection state, compact empty↔loaded region. **Do not use for:** unrelated routes or long text blocks.
- **Values:** `120ms` out + `200ms` in, overlap `40ms`, opacity only, `var(--ease-out)`; optional blur `2px` only when shapes clash.
- **Web — CSS first:** stack both states in one grid area; old `opacity:0` in `120ms`, new `opacity:1` in `200ms`; remove old after transition end.
- **Web — Motion:** only when React exit mounting is needed: `AnimatePresence mode="sync"`; opacity uses tween while layout may use a spring.
- **Expo — Reanimated:** `FadeOut.duration(120)` + `FadeIn.duration(200)` on keyed, absolutely overlaid children; `ReduceMotion.System`.
- **Interruption & exit:** latest state wins; cancel stale completion callbacks. **Reduced motion:** same opacity transition, no blur.
- **Performance note:** opacity is cheap; blur paints, so keep it `2px`, brief, and small.
- **Modelled on:** [Emil—masking crossfades](https://emilkowal.ski/ui/7-practical-animation-tips), [Motion AnimatePresence](https://motion.dev/docs/react-animate-presence), [Reanimated entering/exiting](https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/entering-exiting-animations/).

## **Continuity transition** · one persistent object changes geometry without losing identity

- **Use in Vivid for:** composer send button becoming stop, card status slot yielding to actions, compact↔expanded approval. **Do not use for:** objects with different meaning.
- **Values:** `200ms var(--ease-in-out)`; position/size by FLIP; color/opacity `120ms`; **S0** if interruptible: physics `1/170/26`, design `.4s/bounce 0`.
- **Web — CSS first:** use a stable DOM node and transition transform/color; use View Transitions only for an occasional snapshot-based state change.
- **Web — Motion:** `layout` on the persistent node with `{type:"spring",stiffness:170,damping:26,mass:1}` when geometry is dynamic.
- **Expo — Reanimated:** stable `Animated.View` + `LinearTransition.duration(200).reduceMotion(System)`; avoid remounting the identity.
- **Interruption & exit:** retarget from current geometry; no queued phases. **Reduced motion:** snap geometry, keep `120ms` color/opacity.
- **Performance note:** FLIP/transform avoids per-frame layout; child text may need position-only layout to avoid stretch.
- **Modelled on:** [Motion layout](https://motion.dev/docs/react-layout-animations), [Rauno—spatial consistency](https://rauno.me/craft/interaction-design), [Reanimated layout transitions](https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/layout-transitions/).

## **Morph** · a simple shape changes into another while retaining one meaning

- **Use in Vivid for:** play↔pause or send↔stop glyph with equal visual bounds. **Do not use for:** arbitrary icons, labels, or different actions.
- **Values:** `200ms var(--ease-in-out)`; opacity crossfade `120ms`; rotation ≤`45deg`; center origin; no bounce.
- **Web — CSS first:** prefer one SVG path with compatible points and `d:path(...)` only where browser support is acceptable; otherwise crossfade two glyphs.
- **Web — Motion:** use `motion.path` only for compatible path data; otherwise Motion adds no value over crossfade.
- **Expo — Reanimated:** use `useAnimatedProps` on `react-native-svg` only for numeric path-compatible props; otherwise `FadeIn/FadeOut` icons.
- **Interruption & exit:** redirect from the current interpolation; state remains semantic throughout. **Reduced motion:** instant glyph swap + `120ms` color.
- **Performance note:** complex path morphing can be CPU-bound; Vivid's default is the two-icon crossfade.
- **Modelled on:** [Motion SVG animation](https://motion.dev/docs/react-svg-animation), [Apple SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols), [Emil—state indication](https://emilkowal.ski/ui/great-animations).

## **Shared element transition** · one item travels into its detail surface

- **Use in Vivid for:** occasional Library tile→preview or approval card→detail. **Do not use for:** thread navigation, virtualized repeated rows, or keyboard actions.
- **Values:** **S0 settle**: physics `mass:1,stiffness:170,damping:26`; design `visualDuration:.4,bounce:0`; Expo `duration:400,dampingRatio:1`; opacity crossfade `200ms`; matching center origin.
- **Web — CSS first:** use `document.startViewTransition(update)` + identical unique `view-transition-name` for simple, non-interruptible route/state changes.
- **Web — Motion:** choose `layoutId` when interruption, live content, nested layout, or scroll compensation matters; use the physics S0 form.
- **Expo — Reanimated:** shared transitions are omitted under reduced motion and remain platform-sensitive; prefer native navigation/shared-transition support where stable, otherwise use a `200ms` crossfade.
- **Interruption & exit:** View Transitions snap on interruption, so reserve them for occasional committed changes; Motion springs retarget. **Reduced motion:** crossfade only.
- **Performance note:** View Transitions animate snapshots; Motion uses transforms. Never assign the same view-transition name to two live elements.
- **Modelled on:** [MDN View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using), [Motion shared layout](https://motion.dev/docs/react-layout-animations#shared-layout-animations), [Reanimated accessibility](https://docs.swmansion.com/react-native-reanimated/docs/guides/accessibility/).

## **Accordion / Collapse** · a disclosure opens enough space to show its content

- **Use in Vivid for:** occasional tool-call details and advanced approval rationale. **Do not use for:** primary thread messages or rapidly toggled filters.
- **Values:** height/grid track + opacity `200ms var(--ease-out)`; content opacity begins immediately; origin top; no overshoot.
- **Web — CSS first:** `.body{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows 200ms var(--ease-out),opacity 200ms var(--ease-out)} .body[data-closed]{grid-template-rows:0fr;opacity:0}` with an inner `overflow:hidden` wrapper.
- **Web — Motion:** use `layout` only when content height is dynamic and CSS grid cannot represent the structure; **S0** physics `1/170/26`, design `.4s/bounce 0`.
- **Expo — Reanimated:** measure with `onLayout`, then animate a clipping wrapper for `200ms`; for list rows prefer `LinearTransition.duration(200)` over per-frame JS measurements.
- **Interruption & exit:** reversal starts at current height; keep the trigger enabled. **Reduced motion:** snap height, fade content `120ms`.
- **Performance note:** this is a sanctioned layout exception; keep duration short and descendants simple.
- **Modelled on:** [Motion layout](https://motion.dev/docs/react-layout-animations), [Reanimated layout transitions](https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/layout-transitions/), [Emil animation recipes](../../animate/RECIPES.md).

## **Direction-aware transition** · forward and back move in opposite directions

- **Use in Vivid for:** native hierarchical mobile navigation only. **Do not use for:** peer tabs, web thread selection, or same-level settings.
- **Values:** platform native timing; custom local pager `16px/250ms var(--ease-in-out)`; back uses `-16px`; no bounce.
- **Web — CSS first:** for an occasional local wizard, set `data-direction` and transition `translateX(±16px)` + opacity; route navigation otherwise appears immediately.
- **Web — Motion:** use `AnimatePresence custom={direction}` only for a true bounded hierarchy that needs exit mounting.
- **Expo — Reanimated:** Expo Router native stack `animation:"default"`; if a custom animation is set, also set `animationMatchesGesture:true`; tabs use `animation:"none"`.
- **Interruption & exit:** native back gesture controls progress 1:1; custom motion must reverse from current value. **Reduced motion:** native stack `animation:"fade"`.
- **Performance note:** native navigation stays off the React render path; do not rebuild it in JS.
- **Modelled on:** [Expo Router stack](https://docs.expo.dev/router/advanced/stack/#animation), [Apple fluid interfaces](https://developer.apple.com/videos/play/wwdc2018/803/), [Rauno interaction design](https://rauno.me/craft/interaction-design).
