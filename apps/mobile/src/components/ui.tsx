import { Face } from "./Face";
export { Face } from "./Face";
import { useRef, useState, useLayoutEffect, type ReactNode } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { DateField } from "./DateField";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from "react-native";
import { ChevronLeft, X, type LucideIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { nativeMetrics } from "@konan/design-tokens/native";
import { MotionPressable } from "./MotionPressable";

export function Label({
  tone = "ink",
  size = "body",
  style,
  ...props
}: TextProps & {
  tone?: "ink" | "ink-2" | "ink-3" | "ink-4" | "accent-ink" | "status-danger" | "status-success";
  size?: keyof typeof MOBILE_TYPOGRAPHY;
}) {
  const { colors } = useTheme();
  return (
    <Text
      {...props}
      style={[
        { color: colors[tone], fontWeight: nativeMetrics["weight-meta"] },
        MOBILE_TYPOGRAPHY[size],
        style,
      ]}
    />
  );
}

// Adapted from T3 Code's ControlPill: native press-in de-duplication and 44pt geometry.
export function ControlPill({
  icon: Icon,
  label,
  accessibilityLabel,
  onPress,
  disabled,
  primary,
  danger,
  activateOnPressIn,
}: {
  icon?: LucideIcon;
  label?: string;
  accessibilityLabel?: string;
  onPress?: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  activateOnPressIn?: boolean;
}) {
  const { colors: c } = useTheme();
  const activatedOnPressIn = useRef(false);
  const color = primary ? c["ink-on-accent"] : danger ? c["status-danger"] : c.ink;
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPressIn={
        activateOnPressIn
          ? () => {
              activatedOnPressIn.current = true;
              onPress?.();
            }
          : undefined
      }
      onPressOut={
        activateOnPressIn
          ? () => {
              setTimeout(() => {
                activatedOnPressIn.current = false;
              }, 0);
            }
          : undefined
      }
      onPress={() => {
        if (!activateOnPressIn || !activatedOnPressIn.current) onPress?.();
      }}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        borderRadius: nativeMetrics["radius-control"] * nativeMetrics["phone-radius-factor"],
        paddingHorizontal: label ? 16 : 10,
        gap: 7,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary
          ? c.accent
          : danger
            ? c["status-danger-soft"]
            : label
              ? c["surface-3"]
              : "transparent",
        borderWidth: label && !primary && !danger ? 0.5 : 0,
        borderColor: c["line-3"],
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {Icon && <Icon pointerEvents="none" size={18} strokeWidth={1.6} color={color} />}
      {label && (
        <Label size="label" style={{ color }}>
          {label}
        </Label>
      )}
    </MotionPressable>
  );
}

// Adapted from T3's AndroidScreenHeader, retaining safe-area and embedded behavior.
export function Header({
  title,
  subtitle,
  onBack,
  trailing,
  embedded,
  nativeHeader = true,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  trailing?: ReactNode;
  embedded?: boolean;
  nativeHeader?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  const useNative =
    Platform.OS === "ios" &&
    !embedded &&
    nativeHeader &&
    typeof navigation.setOptions === "function";
  useLayoutEffect(() => {
    if (!useNative) return;
    navigation.setOptions({
      headerShown: true,
      headerShadowVisible: false,
      headerBackButtonDisplayMode: "minimal",
      headerStyle: { backgroundColor: c["surface-0"] },
      headerTintColor: c.ink,
      title,
      headerTitleStyle: { fontSize: 17, fontWeight: "500" },
      headerRight: () => trailing,
      headerLeft: onBack
        ? () => <ControlPill icon={ChevronLeft} accessibilityLabel="Back" onPress={onBack} />
        : undefined,
    });
  }, [useNative, navigation, title, trailing, onBack, c]);
  if (useNative) return null;
  return (
    <View
      style={{
        backgroundColor: c["surface-0"],
        paddingTop: embedded ? 8 : Math.max(insets.top, 12),
        paddingHorizontal: 16,
        paddingBottom: 10,
      }}
    >
      <View style={[styles.row, { minHeight: 48 }]}>
        {title === "Vivid" && <Face size={28} />}
        {onBack && <ControlPill icon={ChevronLeft} accessibilityLabel="Back" onPress={onBack} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label numberOfLines={1} size="headline">
            {title}
          </Label>
          {subtitle && (
            <Label size="label" tone="ink-3">
              {subtitle}
            </Label>
          )}
        </View>
        {trailing}
      </View>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { colors: c } = useTheme();
  return (
    <View
      style={[
        {
          padding: 16,
          borderRadius: 18,
          backgroundColor: c["surface-2"],
          gap: 10,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function Field({ style, ...props }: TextInputProps) {
  const { colors: c } = useTheme();
  return (
    <TextInput
      {...props}
      placeholderTextColor={c["ink-3"]}
      style={[
        {
          minHeight: 48,
          borderRadius: 14,
          backgroundColor: c["surface-2"],
          paddingHorizontal: 14,
          paddingVertical: 12,
          color: c.ink,
          fontSize: 16,
        },
        style,
      ]}
    />
  );
}
export function Empty({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        paddingVertical: 48,
        paddingHorizontal: 24,
        gap: 12,
      }}
    >
      <Face size={52} />
      <Label size="title" style={{ textAlign: "center" }}>
        {title}
      </Label>
      <Label tone="ink-3" style={{ textAlign: "center", maxWidth: 320 }}>
        {detail}
      </Label>
      {children}
    </View>
  );
}
export function Feedback({
  error,
  loading,
  retry,
  retryLabel = "Try again",
}: {
  error?: string;
  loading?: boolean;
  retry?: () => void;
  retryLabel?: string;
}) {
  const { colors: c } = useTheme();
  if (loading)
    return (
      <ActivityIndicator accessibilityLabel="Loading" color={c.accent} style={{ padding: 24 }} />
    );
  if (!error) return null;
  return (
    <Card>
      <Label tone="status-danger">{error}</Label>
      {retry && <ControlPill label={retryLabel} onPress={retry} />}
    </Card>
  );
}
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={Platform.OS === "ios"}
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: c["surface-0"],
          paddingBottom: insets.bottom,
        }}
      >
        <Header
          nativeHeader={false}
          title={title}
          trailing={<ControlPill icon={X} accessibilityLabel="Close" onPress={onClose} />}
        />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{ padding: 20, gap: 16 }}
        >
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}
export function EditSheet({
  title,
  fields,
  onClose,
  onSave,
}: {
  title: string;
  fields: {
    key: string;
    label: string;
    value?: string;
    multiline?: boolean;
    secure?: boolean;
    date?: boolean;
    options?: { label: string; value: string }[];
    allowCustom?: boolean;
  }[];
  onClose: () => void;
  onSave: (values: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.value ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title={title} onClose={onClose}>
      {fields.map((f) => (
        <View key={f.key} style={{ gap: 8 }}>
          <Label size="label" tone="ink-2">
            {f.label}
          </Label>
          {f.options && (
            <View style={styles.wrap}>
              {f.options.map((option) => (
                <ControlPill
                  key={option.value}
                  label={option.label}
                  primary={values[f.key] === option.value}
                  onPress={() => setValues((v) => ({ ...v, [f.key]: option.value }))}
                />
              ))}
              {f.allowCustom && (
                <ControlPill
                  label="Custom schedule"
                  onPress={() => setValues((v) => ({ ...v, [f.key]: "" }))}
                />
              )}
            </View>
          )}
          {f.date ? (
            <DateField
              label={f.label}
              value={values[f.key]}
              onChange={(value) => setValues((v) => ({ ...v, [f.key]: value }))}
            />
          ) : (
            (!f.options ||
              (f.allowCustom && !f.options.some((o) => o.value === values[f.key]))) && (
              <Field
                accessibilityLabel={f.label}
                value={values[f.key]}
                multiline={f.multiline}
                secureTextEntry={f.secure}
                autoCapitalize={f.secure ? "none" : "sentences"}
                onChangeText={(value) => setValues((v) => ({ ...v, [f.key]: value }))}
              />
            )
          )}
        </View>
      ))}
      <Feedback error={error} />
      <ControlPill
        primary
        label={busy ? "Saving…" : "Save"}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void onSave(values)
            .then(onClose)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      />
    </Sheet>
  );
}
export function confirmDelete(title: string, action: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`Delete “${title}”?`)) action();
  } else
    Alert.alert(`Delete “${title}”?`, "This cannot be undone.", [
      { text: "Keep", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: action },
    ]);
}
export const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  page: { padding: 20, gap: 16, paddingBottom: 40 },
});
