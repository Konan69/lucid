import { SymbolView } from './Symbol'
import { ControlPillMenu } from './Menu'
import type { MenuAction } from '@react-native-menu/menu'
import * as Haptics from 'expo-haptics'
import {
  createContext,
  use,
  useCallback,
  useEffectEvent,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import type {
  ColorValue,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from 'react-native'
import { Pressable, View } from 'react-native'
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
} from 'react-native-reanimated'

import { Label as Text } from '../ui/ui'
import { useTheme } from '../theme'

// Wide enough for the longest action label ("Unarchive").
const ACTION_ITEM_WIDTH = 58
const ACTION_CIRCLE_SIZE = 36
const ACTION_ICON_SIZE = 15
const COMPACT_ACTION_CIRCLE_SIZE = 28
const COMPACT_ACTION_ICON_SIZE = 13

function closeSwipeable(ref: { readonly current: SwipeableMethods | null }) {
  const current = ref.current
  if (current !== null) current.close()
}

function resetSwipeable(ref: { readonly current: SwipeableMethods | null }) {
  const current = ref.current
  if (current !== null) current.reset()
}

export const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2
export const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
}

interface ThreadSwipeAction {
  readonly accessibilityLabel: string
  readonly icon: ComponentProps<typeof SymbolView>['name']
  readonly label: string
  readonly menu?: {
    readonly actions: MenuAction[]
    readonly onPressAction: NonNullable<ComponentProps<typeof ControlPillMenu>['onPressAction']>
    readonly title?: string
  }
  readonly onPress: () => void
}

interface ThreadSwipeSecondaryAction extends ThreadSwipeAction {
  readonly backgroundColor: string
}

function swipeActionsWidth(hasSecondaryAction: boolean) {
  return hasSecondaryAction ? THREAD_SWIPE_ACTIONS_WIDTH : ACTION_ITEM_WIDTH
}

/** `undefined` keeps the v1 Delete default; `null` means one action only. */
function resolveSecondaryAction(input: {
  readonly close: () => void
  readonly onDelete: () => void
  readonly secondaryAction?: ThreadSwipeAction | null
  readonly threadTitle: string
  readonly dangerColor: string
  readonly actionColor: string
}): ThreadSwipeSecondaryAction | null {
  if (input.secondaryAction === null) return null
  if (input.secondaryAction === undefined) {
    return {
      accessibilityLabel: `Delete ${input.threadTitle}`,
      backgroundColor: input.dangerColor,
      icon: 'trash',
      label: 'Delete',
      onPress: () => {
        input.close()
        input.onDelete()
      },
    }
  }
  const action = input.secondaryAction
  const menu = action.menu
  return {
    ...action,
    backgroundColor: input.actionColor,
    menu:
      menu === undefined
        ? undefined
        : {
            ...menu,
            onPressAction: (event) => {
              input.close()
              menu.onPressAction(event)
            },
          },
    onPress: () => {
      input.close()
      action.onPress()
    },
  }
}

/**
 * Delivers the scroll gate to swipeables via context so that flipping it does
 * NOT re-render whole rows: putting the flag in list extraData/renderItem deps
 * re-rendered every visible row (hooks, subscriptions and all) exactly at
 * scroll start — peak frame pressure. As a context value only the
 * ThreadSwipeable consumers re-render.
 */
const SwipeableScrollGateContext = createContext(true)

export function SwipeableScrollGateProvider(props: {
  readonly enabled: boolean
  readonly children: ReactNode
}) {
  return (
    <SwipeableScrollGateContext.Provider value={props.enabled}>
      {props.children}
    </SwipeableScrollGateContext.Provider>
  )
}

/**
 * T3's scroll gate disables swipes while the list is dragging or decelerating.
 * T3's Gesture Handler patch also rejects vertically dominant initial pans.
 */
export function useSwipeableScrollGate(
  options: {
    readonly onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
    readonly onScrollBeginDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  } = {},
) {
  const [gateActive, setGateActive] = useState(false)
  const gateActiveRef = useRef(false)
  const draggingRef = useRef(false)
  const dragStartYRef = useRef(0)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const externalOnScroll = options.onScroll
  const externalOnScrollBeginDrag = options.onScrollBeginDrag

  const update = useCallback((next: boolean) => {
    if (gateActiveRef.current !== next) {
      gateActiveRef.current = next
      setGateActive(next)
    }
  }, [])
  const clearSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])
  useEffect(() => clearSettle, [clearSettle])

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true
      dragStartYRef.current = event.nativeEvent.contentOffset.y
      clearSettle()
      if (externalOnScrollBeginDrag !== undefined) externalOnScrollBeginDrag(event)
    },
    [clearSettle, externalOnScrollBeginDrag],
  )
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Only vertical movement during a user drag arms the gate — a purely
      // horizontal row swipe never moves contentOffset.y, and inset-driven
      // offset changes at mount happen outside a drag.
      if (
        draggingRef.current &&
        !gateActiveRef.current &&
        Math.abs(event.nativeEvent.contentOffset.y - dragStartYRef.current) > 4
      ) {
        update(true)
      }
      if (externalOnScroll !== undefined) externalOnScroll(event)
    },
    [externalOnScroll, update],
  )
  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false
    clearSettle()
    // If momentum follows, onMomentumScrollBegin cancels this and the gate
    // stays armed until the deceleration finishes.
    settleTimerRef.current = setTimeout(() => update(false), 160)
  }, [clearSettle, update])
  const onMomentumScrollBegin = useCallback(() => {
    clearSettle()
  }, [clearSettle])
  const onMomentumScrollEnd = useCallback(() => {
    update(false)
  }, [update])

  return {
    swipeEnabled: !gateActive,
    scrollGateHandlers: {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  }
}

export function ThreadSwipeable(props: {
  readonly backgroundColor: ColorValue
  readonly children: (close: () => void) => ReactNode
  /** Uses action visuals that fit inside compact 44pt rows. The press target
   * still spans the row's full height and width. */
  readonly compactActions?: boolean
  readonly containerStyle?: StyleProp<ViewStyle>
  /** Disables NEW swipe activations (e.g. while the list scrolls). */
  readonly enabled?: boolean
  readonly enableTrackpadSwipe?: boolean
  /**
   * What a full swipe commits. Omitted keeps the v1 Delete behavior only when
   * the built-in Delete secondary action is in use; custom or absent
   * secondary actions default to the advertised primary action.
   */
  readonly fullSwipeAction?: 'delete' | 'primary'
  readonly fullSwipeWidth: number
  readonly onDelete: () => void
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void
  readonly primaryAction: ThreadSwipeAction
  /**
   * Omitted keeps the v1 destructive Delete action. Explicit null opts out of
   * a secondary action entirely so a gated Snooze can never fall back to an
   * unadvertised Delete.
   */
  readonly secondaryAction?: ThreadSwipeAction | null
  /**
   * Identity of the content being wrapped. When a recycled list reuses this
   * component for a different item, the swipeable snaps back to closed so an
   * open/mid-drag state can't leak onto another row.
   */
  readonly resetKey?: string
  readonly simultaneousWithExternalGesture?: ComponentProps<
    typeof ReanimatedSwipeable
  >['simultaneousWithExternalGesture']
  readonly threadTitle: string
}) {
  const { colors: c } = useTheme()
  const swipeableRef = useRef<SwipeableMethods | null>(null)
  const fullSwipeArmedRef = useRef(false)
  const hasSecondaryAction = props.secondaryAction !== null
  const actionsWidth = swipeActionsWidth(hasSecondaryAction)
  const fullSwipeThreshold = Math.max(actionsWidth + 44, props.fullSwipeWidth * 0.58)
  const fullSwipeAction =
    props.fullSwipeAction ?? (props.secondaryAction === undefined ? 'delete' : 'primary')
  const close = useEffectEvent(() => closeSwipeable(swipeableRef))
  const gateEnabled = use(SwipeableScrollGateContext)
  const resetKey = props.resetKey
  useEffect(() => {
    if (resetKey === undefined) {
      return
    }
    fullSwipeArmedRef.current = false
    resetSwipeable(swipeableRef)
  }, [resetKey])
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    }
    fullSwipeArmedRef.current = armed
  }, [])

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: props.backgroundColor }}
      containerStyle={[{ backgroundColor: props.backgroundColor }, props.containerStyle]}
      dragOffsetFromRightEdge={8}
      enabled={props.enabled !== false && gateEnabled}
      enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
      failOffsetY={[-10, 10]}
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false
        if (swipeableRef.current) {
          if (props.onSwipeableClose !== undefined) props.onSwipeableClose(swipeableRef.current)
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          if (props.onSwipeableWillOpen !== undefined)
            props.onSwipeableWillOpen(swipeableRef.current)
        }
      }}
      onSwipeableWillOpen={() => {
        const methods = swipeableRef.current
        if (!methods) {
          return
        }

        if (props.onSwipeableWillOpen !== undefined) props.onSwipeableWillOpen(methods)
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false
          methods.close()
          if (fullSwipeAction === 'primary') {
            props.primaryAction.onPress()
          } else {
            props.onDelete()
          }
        }
      }}
      overshootFriction={1}
      overshootRight
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={props.backgroundColor}
          compact={props.compactActions === true}
          fullSwipeAction={fullSwipeAction}
          fullSwipeThreshold={fullSwipeThreshold}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            ...props.primaryAction,
            onPress: () => {
              methods.close()
              props.primaryAction.onPress()
            },
          }}
          secondaryAction={resolveSecondaryAction({
            dangerColor: c['status-danger'],
            actionColor: c.accent,
            close: () => methods.close(),
            onDelete: props.onDelete,
            secondaryAction: props.secondaryAction,
            threadTitle: props.threadTitle,
          })}
          translation={translation}
        />
      )}
      rightThreshold={actionsWidth * 0.42}
      simultaneousWithExternalGesture={props.simultaneousWithExternalGesture}
    >
      {props.children(close)}
    </ReanimatedSwipeable>
  )
}

type SwipeActionButtonContentProps = {
  readonly accessibilityLabel: string
  readonly backgroundColor: string
  readonly circleSize: number
  readonly compact: boolean
  readonly icon: ComponentProps<typeof SymbolView>['name']
  readonly iconSize: number
  readonly label: string
  readonly menu?: ThreadSwipeAction['menu']
  readonly onPress: () => void
  readonly circleStyle: ReturnType<typeof useAnimatedStyle>
  readonly iconStyle: ReturnType<typeof useAnimatedStyle>
  readonly labelStyle: ReturnType<typeof useAnimatedStyle>
}

/** Renders the swipe action's press target while its parent owns motion calculations. */
function SwipeActionButtonContent(props: SwipeActionButtonContentProps) {
  const { colors: c } = useTheme()
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={props.menu === undefined ? props.onPress : undefined}
      style={({ pressed }) => ({
        alignItems: 'center',
        height: '100%',
        justifyContent: 'center',
        opacity: pressed ? 0.72 : 1,
        width: '100%',
      })}
    >
      <View style={{ height: props.circleSize, width: props.circleSize }}>
        <Animated.View
          style={[
            {
              backgroundColor: props.backgroundColor,
              borderRadius: 999,
              height: props.circleSize,
              left: 0,
              position: 'absolute',
              top: 0,
            },
            props.circleStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              alignItems: 'center',
              height: props.circleSize,
              justifyContent: 'center',
              left: 0,
              position: 'absolute',
              top: 0,
              width: props.circleSize,
            },
            props.iconStyle,
          ]}
        >
          <SymbolView
            name={props.icon}
            size={props.iconSize}
            tintColor={c['ink-on-color']}
            type="monochrome"
          />
        </Animated.View>
      </View>
      <Animated.View
        style={[
          {
            height: 14,
            justifyContent: 'center',
            paddingTop: props.compact ? 0 : 2,
          },
          props.labelStyle,
        ]}
      >
        <Text size="micro" tone="ink-3" numberOfLines={1}>
          {props.label}
        </Text>
      </Animated.View>
    </Pressable>
  )
}

function SwipeActionButton(props: {
  readonly accessibilityLabel: string
  readonly actionsWidth: number
  readonly backgroundColor: string
  readonly compact: boolean
  readonly entryRange: readonly [number, number]
  readonly fullSwipeThreshold: number
  readonly icon: ComponentProps<typeof SymbolView>['name']
  readonly label: string
  readonly menu?: ThreadSwipeAction['menu']
  readonly onPress: () => void
  readonly stretchesOnFullSwipe: boolean
  readonly translation: SharedValue<number>
}) {
  const circleSize = props.compact ? COMPACT_ACTION_CIRCLE_SIZE : ACTION_CIRCLE_SIZE
  const iconSize = props.compact ? COMPACT_ACTION_ICON_SIZE : ACTION_ICON_SIZE
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0)
    const entryProgress = interpolate(reveal, props.entryRange, [0, 1], Extrapolation.CLAMP)
    const stretch = Math.max(reveal - props.actionsWidth, 0)
    const fullSwipeProgress = interpolate(
      reveal,
      [props.actionsWidth, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    )

    return {
      opacity: props.stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [22, 0]) -
            (props.stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    }
  })
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0)
    const stretch = props.stretchesOnFullSwipe ? Math.max(reveal - props.actionsWidth, 0) : 0

    return {
      transform: [{ translateX: -stretch }],
      width: circleSize + stretch,
    }
  })
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0)
    const stretch = props.stretchesOnFullSwipe ? Math.max(reveal - props.actionsWidth, 0) : 0
    const armedProgress = interpolate(
      reveal,
      [props.fullSwipeThreshold, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    )

    return {
      transform: [{ translateX: -stretch * (0.5 + armedProgress * 0.5) }],
    }
  })
  const labelStyle = useAnimatedStyle(() => {
    if (!props.stretchesOnFullSwipe) {
      return { opacity: 1 }
    }

    const reveal = Math.max(-props.translation.value, 0)
    const stretch = Math.max(reveal - props.actionsWidth, 0)
    return {
      opacity: interpolate(
        reveal,
        [props.fullSwipeThreshold - 24, props.fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: -stretch * 0.5 }],
    }
  })

  const button = (
    <SwipeActionButtonContent
      accessibilityLabel={props.accessibilityLabel}
      backgroundColor={props.backgroundColor}
      circleSize={circleSize}
      compact={props.compact}
      icon={props.icon}
      iconSize={iconSize}
      label={props.label}
      menu={props.menu}
      onPress={props.onPress}
      circleStyle={circleStyle}
      iconStyle={iconStyle}
      labelStyle={labelStyle}
    />
  )

  return (
    <Animated.View
      style={[
        {
          alignItems: 'center',
          height: '100%',
          justifyContent: 'center',
          width: ACTION_ITEM_WIDTH,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      {props.menu === undefined ? (
        button
      ) : (
        <ControlPillMenu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: '100%', width: '100%' }}
        >
          {button}
        </ControlPillMenu>
      )}
    </Animated.View>
  )
}

export function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue
  readonly compact: boolean
  readonly fullSwipeAction?: 'delete' | 'primary'
  readonly fullSwipeThreshold: number
  readonly onFullSwipeArmedChange: (armed: boolean) => void
  readonly primaryAction: ThreadSwipeAction
  readonly secondaryAction: ThreadSwipeSecondaryAction | null
  readonly translation: SharedValue<number>
}) {
  const { colors: c } = useTheme()
  const secondaryAction = props.secondaryAction
  const fullSwipeIsPrimary = props.fullSwipeAction === 'primary' || secondaryAction === null
  const actionsWidth = swipeActionsWidth(secondaryAction !== null)
  useAnimatedReaction(
    () => -props.translation.value >= props.fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(props.onFullSwipeArmedChange)(armed)
      }
    },
    [props.fullSwipeThreshold, props.onFullSwipeArmedChange],
  )

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: 'row',
        height: '100%',
        width: actionsWidth,
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        actionsWidth={actionsWidth}
        backgroundColor={c.accent}
        compact={props.compact}
        entryRange={
          secondaryAction === null
            ? [8, ACTION_ITEM_WIDTH * 0.72]
            : [ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]
        }
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        stretchesOnFullSwipe={fullSwipeIsPrimary}
        translation={props.translation}
      />
      {secondaryAction === null ? null : (
        <SwipeActionButton
          accessibilityLabel={secondaryAction.accessibilityLabel}
          actionsWidth={actionsWidth}
          backgroundColor={secondaryAction.backgroundColor}
          compact={props.compact}
          entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
          fullSwipeThreshold={props.fullSwipeThreshold}
          icon={secondaryAction.icon}
          label={secondaryAction.label}
          menu={secondaryAction.menu}
          onPress={secondaryAction.onPress}
          stretchesOnFullSwipe={!fullSwipeIsPrimary}
          translation={props.translation}
        />
      )}
    </View>
  )
}
