import type { FeedAction } from '@vivid/contracts'
import { feed } from '@vivid/state'
import { Option } from 'effect'
import { View } from 'react-native'
import Animated, { Easing, Keyframe, ReduceMotion } from 'react-native-reanimated'
import { putAway } from '../../data/feed'
import type { LiveData } from '../../data/live'
import { Card, sidesOf } from '../Feed'
import { Swipe } from '../feed/Swipe'

/**
 * The card Vivid posted from this chat, floating over the foot of the conversation above the
 * composer: the Feed's own card, answered or put away the way the Feed's are (direction B of the
 * 11 November 2026 motion study, `feed-openui-cards/thread-card.html`).
 *
 * Once the Person acts on it, it is gone from here: it keeps no sending or failed state of its own.
 * An answer is the chat's own message (`onSpeak`), which says if it did not arrive as any message
 * does; putting it away tells Vivid (`putAway`), which takes a turn and answers in the chat. The
 * card leaves on the frame of the press or the throw, and the conversation's foot settles on the
 * same clock (`Conversation`, `room`).
 */
export function Posted({
  data,
  item,
  now,
  bottom,
  onSpeak,
  onSettle,
  onGone,
  onHeight,
}: {
  data: LiveData
  item: feed.Waiting
  now: number
  /** How far above the screen's foot the card stands: the composer's dock and a gap. */
  bottom: number
  /** Says the card's answer in this chat, as the Person's own message. */
  onSpeak: (words: FeedAction) => void
  /** Closes the card's place on the Feed after an answer said here. */
  onSettle: () => void
  /** The card left this chat; it is drawn no more until Vivid posts again. */
  onGone: () => void
  /** The card was laid out this tall, which the conversation keeps clear under its newest words. */
  onHeight: (height: number) => void
}) {
  const post = Option.fromNullOr(item.post)
  const title = Option.match(post, { onNone: () => item.from, onSome: (made) => made.title })
  // Leaving is decided here and nowhere else: the card goes at once, whatever the call does.
  const answer = (words: FeedAction) => {
    onGone()
    onSpeak(words)
    onSettle()
  }
  const away = () => {
    onGone()
    putAway(data, item, title)
  }
  const reply = {
    held: false,
    onSay: answer,
    onDraw: (words: string) => answer(words),
    onDone: away,
  }
  return (
    <Animated.View
      entering={ARRIVE}
      exiting={LEAVE}
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 12, right: 12, bottom }}
    >
      <View onLayout={(event) => onHeight(event.nativeEvent.layout.height)}>
        <Swipe
          sides={sidesOf(post, Option.none(), { ...reply, onOpen: () => undefined })}
          held={false}
        >
          <Card
            card={item.card}
            at={item.at}
            post={post}
            ask={{ title: item.from, words: feed.askedWords(item) }}
            asked={Option.none()}
            reply={Option.some(reply)}
            now={now}
            remember={Option.some({ post: feed.revisionOf(item) })}
            onOpen={() => undefined}
          />
        </Swipe>
      </View>
    </Animated.View>
  )
}

/** The strong ease-out every arrival and leaving here uses (`animate-expo`). */
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1)

/**
 * Arrives once Vivid has said it: from 0.96 and 8 points low, in 220 ms. Nothing inside the card
 * moves on its own; it is one entrance.
 */
const ARRIVE = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 8 }, { scale: 0.96 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: EASE_OUT },
})
  .duration(220)
  .reduceMotion(ReduceMotion.System)

/**
 * Leaves as it came, faster: 150 ms. A thrown card is already off the screen when it unmounts, so
 * this is only seen after a press.
 */
const LEAVE = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
  100: { opacity: 0, transform: [{ translateY: 8 }, { scale: 0.96 }], easing: EASE_OUT },
})
  .duration(150)
  .reduceMotion(ReduceMotion.System)
