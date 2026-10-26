import { useAtomSet, useAtomValue } from '@effect/atom-react'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { ConnectionState } from '@vivid/contracts'
import { attaching } from '@vivid/state'
import { Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { Blocks, Camera, FileUp, Images, type LucideIcon } from 'lucide-react-native'
import { useState } from 'react'
import { ActivityIndicator, Image, ScrollView, View } from 'react-native'
import { start } from '../../data/app'
import { addRecent, chooseFrom, recentPhotos } from '../../data/attach'
import { useLiveData, useLiveValue } from '../../data/live'
import { useTheme } from '../../theme'
import { Row, Section } from '../../ui/List'
import { FittedSheet } from '../../ui/Sheet'
import { Button, Label, Press, radius } from '../../ui/ui'
import type { Routes } from '../../workspace'
import { useFlow } from '../integration/flow'

/** A source tile's side, and a recent photo's, in points: three across a phone's sheet. */
const TILE = 96

/**
 * What the composer's + opens over a Thread: where a file comes from, the newest photos, and the
 * Person's Integrations. The layout is the Claude app's "Add to Chat" sheet, which the developer
 * chose on 26 October 2026: three source tiles, a line that shows recent photos in their place,
 * and the Integrations row. Its "Add to project" is left out; a Thread has no project files.
 *
 * It is a route (`Add`, `workspace.ts`) drawn as the platform's bottom sheet (`FITTED_SHEET`).
 * A tile keeps the sheet up while its picker is over it and closes it when the picker has
 * answered (`chooseFrom`, `data/attach.ts`, says why). Recent photos are tapped to pick, numbered
 * in the order picked, and join the tray with one press, as the Claude app does.
 *
 * Whether the recent strip shows and which photos are picked are plain state of this sheet:
 * nothing waits on either, and both go with the sheet.
 */
export function Add({ route, navigation }: NativeStackScreenProps<Routes, 'Add'>) {
  const { thread, shared } = route.params
  const data = useLiveData()
  const [recent, setRecent] = useState(false)
  const [picked, setPicked] = useState<ReadonlyArray<attaching.Chosen>>([])
  // Popped by this sheet's own key, so a sheet that is already gone pops nothing else.
  const close = () => navigation.dispatch({ type: 'POP', payload: { count: 1 }, source: route.key })
  const choose = (source: attaching.Source) =>
    void start(chooseFrom(data, thread, shared, source)).then(close)

  const toggle = (photo: attaching.Chosen) =>
    setPicked((now) =>
      now.some((one) => one.key === photo.key)
        ? now.filter((one) => one.key !== photo.key)
        : now.length < attaching.MOST_PICTURES
          ? [...now, photo]
          : now,
    )
  const addPicked = () => {
    for (const photo of picked) addRecent(data, thread, shared, photo)
    close()
  }

  return (
    <FittedSheet title="Add to Thread">
      {recent ? (
        <Recent picked={picked} onCamera={() => choose('Camera')} onToggle={toggle} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Tile icon={Camera} label="Camera" onPress={() => choose('Camera')} />
          <Tile icon={Images} label="Photos" onPress={() => choose('Photos')} />
          <Tile icon={FileUp} label="Files" onPress={() => choose('Files')} />
        </View>
      )}
      {picked.length > 0 ? (
        <Button
          kind="primary"
          label={picked.length === 1 ? 'Add 1 photo' : `Add ${picked.length} photos`}
          onPress={addPicked}
        />
      ) : (
        <Section title="More">
          {recent ? (
            <Row
              key="all"
              leading={<Mark icon={Images} />}
              title="All photos"
              onPress={() => choose('Photos')}
            />
          ) : (
            <Row
              key="recent"
              leading={<Mark icon={Images} />}
              title="Show recent photos"
              onPress={() => setRecent(true)}
            />
          )}
          {recent && (
            <Row
              key="files"
              leading={<Mark icon={FileUp} />}
              title="Add files"
              onPress={() => choose('Files')}
            />
          )}
          <Integrations key="integrations" onOpen={() => navigation.replace('Integrations')} />
        </Section>
      )}
    </FittedSheet>
  )
}

/**
 * The Integrations row and how many are connected. It opens the Integrations page as a new
 * visit, as Settings does: the search starts empty and the shell's flow from rest.
 */
function Integrations({ onOpen }: { onOpen: () => void }) {
  const data = useLiveData()
  const flow = useFlow()
  const setSearch = useAtomSet(data.serviceSearch)
  const connections = useLiveValue(data.live.connections)
  const ready = Option.match(connections, {
    onNone: () => Option.none<number>(),
    onSome: (value) =>
      Option.some(
        value.connections.filter((item) => ConnectionState.guards.Ready(item.state)).length,
      ),
  })
  return (
    <Row
      leading={<Mark icon={Blocks} />}
      title="Integrations"
      detail={Option.getOrUndefined(Option.map(ready, (count) => `${count} connected`))}
      onPress={() => {
        setSearch('')
        flow.rest()
        onOpen()
      }}
    />
  )
}

/** A row's leading glyph, in the ink and weight of the sheet's tiles. */
function Mark({ icon: Icon }: { icon: LucideIcon }) {
  const { colors: c } = useTheme()
  return <Icon size={20} strokeWidth={1.7} color={c.foreground} />
}

/** One source: a square with its glyph over its name. */
function Tile({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon
  label: string
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        height: TILE,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: pressed ? c['row-hover'] : c['grouped-card'],
      })}
    >
      <Icon size={24} strokeWidth={1.7} color={c.foreground} />
      <Label size="label">{label}</Label>
    </Press>
  )
}

/**
 * The camera, then the newest photos, in one line that scrolls sideways. Reading the photos asks
 * for the library the first time (`recentPhotos`); without it the line is the camera alone and
 * "All photos" still opens the system's picker, which needs no access.
 */
function Recent({
  picked,
  onCamera,
  onToggle,
}: {
  picked: ReadonlyArray<attaching.Chosen>
  onCamera: () => void
  onToggle: (photo: attaching.Chosen) => void
}) {
  const { colors: c } = useTheme()
  const photos = useAtomValue(recentPhotos)
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8 }}
    >
      <View style={{ width: TILE }}>
        <Tile icon={Camera} label="Camera" onPress={onCamera} />
      </View>
      {AsyncResult.isSuccess(photos) ? (
        photos.value.map((photo) => (
          <Photo
            key={photo.key}
            photo={photo}
            place={picked.findIndex((one) => one.key === photo.key)}
            onPress={() => onToggle(photo)}
          />
        ))
      ) : (
        <View style={{ width: TILE, height: TILE, justifyContent: 'center' }}>
          <ActivityIndicator color={c['ink-3']} />
        </View>
      )}
    </ScrollView>
  )
}

/** One recent photo; picked ones carry the accent ring and their place in the order picked. */
function Photo({
  photo,
  place,
  onPress,
}: {
  photo: attaching.Chosen
  /** Where it is among the picked photos, or -1 when it is not picked. */
  place: number
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const chosen = place >= 0
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={photo.name}
      accessibilityState={{ selected: chosen }}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
    >
      <Image
        source={{ uri: photo.uri }}
        style={{
          width: TILE,
          height: TILE,
          borderRadius: radius.card,
          backgroundColor: c['surface-well'],
          borderWidth: chosen ? 3 : 0,
          borderColor: c.primary,
        }}
      />
      {chosen && (
        <View
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.primary,
            borderWidth: 2,
            borderColor: c.screen,
          }}
        >
          <Label size="caption" style={{ color: c['primary-foreground'], fontWeight: '700' }}>
            {place + 1}
          </Label>
        </View>
      )}
    </Press>
  )
}
