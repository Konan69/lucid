import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, View } from "react-native";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowUp,
  PanelLeft,
  PanelRight,
  Paperclip,
  ScrollText,
  Square,
  Library,
  Repeat2,
} from "lucide-react-native";
import Animated, {
  FadeIn,
  FadeOut,
  FadeInDown,
  FadeOutDown,
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";
import { nativeMetrics as m } from "@vivid/design-tokens/native";
import { ComposerEditor } from "../native/T3ComposerEditor";
import type { ComposerEditorHandle } from "../native/T3ComposerEditor.types";
import { useSidebar, type Routes } from "../workspace";
import { useTheme } from "../theme";
import { ControlPill, Face, Label, Sheet } from "./ui";
import { MotionPressable } from "./MotionPressable";

// T3 ThreadComposer: toolbar 160/120, status 180/140; Android leaves height to IME.
const toolbarIn = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const toolbarOut = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const statusIn = FadeInDown.duration(180).reduceMotion(ReduceMotion.System);
const statusOut = FadeOutDown.duration(140).reduceMotion(ReduceMotion.System);
const composerLayout =
  Platform.OS === "ios"
    ? LinearTransition.duration(220).reduceMotion(ReduceMotion.System)
    : undefined;

export function useChatKeyboard() {
  const [visible, setVisible] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

export function ChatHeader({
  title = "Vivid",
  working = false,
  fresh = false,
  onOpenLog,
  onOpenScreen,
}: {
  title?: string;
  working?: boolean;
  fresh?: boolean;
  onOpenLog?: () => void;
  onOpenScreen?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const sidebar = useSidebar();
  return (
    <View style={{ paddingTop: insets.top, paddingHorizontal: 8 }}>
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: m["topbar-h"] }}
      >
        <ControlPill icon={PanelLeft} accessibilityLabel="Open sidebar" onPress={sidebar.open} />
        {fresh && <Face size={22} mood={working ? "thinking" : "neutral"} />}
        <Label size="footnote" numberOfLines={1} style={{ flex: 1, marginLeft: 6 }}>
          {title}
        </Label>
        {onOpenLog && (
          <ControlPill icon={ScrollText} accessibilityLabel="What Vivid did" onPress={onOpenLog} />
        )}
        {onOpenScreen && (
          <ControlPill
            icon={PanelRight}
            accessibilityLabel="Vivid's screen"
            onPress={onOpenScreen}
          />
        )}
      </View>
    </View>
  );
}

// Vivid web Composer geometry and controls around T3's actual native editor.
export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
  working,
  onStop,
  keyboardVisible,
  focusRequest = 0,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  disabled?: boolean;
  working?: boolean;
  onStop?: () => void;
  keyboardVisible: boolean;
  focusRequest?: number;
}) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavigationProp<Routes>>();
  const editor = useRef<ComposerEditorHandle>(null);
  const [height, setHeight] = useState(44);
  const [tools, setTools] = useState(false);
  useEffect(() => {
    if (!focusRequest) return;
    const currentEditor = editor.current;
    if (currentEditor !== null) currentEditor.focus();
  }, [focusRequest]);
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: keyboardVisible ? 10 : Math.max(insets.bottom, 12),
      }}
    >
      <Animated.View
        layout={composerLayout}
        style={{
          width: "100%",
          maxWidth: 760,
          alignSelf: "center",
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: 10,
          borderRadius: m["radius-composer"] * m["phone-radius-factor"],
          backgroundColor: c["surface-3"],
          borderWidth: 0.5,
          borderColor: c["line-2"],
        }}
      >
        <ComposerEditor
          ref={editor}
          placeholder="Message Vivid"
          value={value}
          onChangeText={onChange}
          multiline
          onSubmit={() => {
            if (!disabled && !working) onSend();
          }}
          contentInsetVertical={8}
          onContentHeightChange={(next) => setHeight(Math.min(144, Math.max(44, next)))}
          style={{ height, marginHorizontal: 8 }}
          textStyle={{ fontSize: m["type-body"], lineHeight: 23 }}
        />
        <Animated.View
          entering={toolbarIn}
          exiting={toolbarOut}
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <ControlPill
            icon={Paperclip}
            accessibilityLabel="Attachments and tools"
            onPress={() => {
              Keyboard.dismiss();
              setTools(true);
            }}
          />
          <View style={{ flex: 1 }}>
            {working && (
              <Animated.View
                entering={statusIn}
                exiting={statusOut}
                style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Face size={16} mood="thinking" />
                <Label size="caption" tone="ink-3">
                  Working…
                </Label>
              </Animated.View>
            )}
          </View>
          <MotionPressable
            accessibilityRole="button"
            accessibilityLabel={working ? "Stop response" : "Send message"}
            accessibilityState={{ disabled: !working && (!!disabled || !value.trim()) }}
            disabled={!working && (disabled || !value.trim())}
            onPress={working ? onStop : onSend}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: working ? c["status-danger"] : c.accent,
              opacity: pressed ? 0.7 : !working && (disabled || !value.trim()) ? 0.4 : 1,
            })}
          >
            {working ? (
              <Square
                pointerEvents="none"
                size={15}
                color={c["ink-on-accent"]}
                fill={c["ink-on-accent"]}
              />
            ) : (
              <ArrowUp
                pointerEvents="none"
                size={20}
                strokeWidth={1.6}
                color={c["ink-on-accent"]}
              />
            )}
          </MotionPressable>
        </Animated.View>
      </Animated.View>
      {tools && (
        <Sheet title="Attachments and tools" onClose={() => setTools(false)}>
          {(
            [
              { name: "Library", label: "Library", detail: "Find or add a file", icon: Library },
              { name: "Routines", label: "Routines", detail: "Work that repeats", icon: Repeat2 },
            ] as const
          ).map(({ name, label, detail, icon: Icon }) => (
            <MotionPressable
              key={name}
              accessibilityRole="button"
              onPress={() => {
                setTools(false);
                navigation.navigate(name);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 60,
                paddingHorizontal: 10,
                borderRadius: m["radius-row"],
                backgroundColor: pressed ? c["wash-hover"] : "transparent",
              })}
            >
              <Icon size={18} strokeWidth={1.6} color={c["ink-3"]} />
              <View>
                <Label size="label">{label}</Label>
                <Label size="caption" tone="ink-3" style={{ fontWeight: "400" }}>
                  {detail}
                </Label>
              </View>
            </MotionPressable>
          ))}
        </Sheet>
      )}
    </View>
  );
}
