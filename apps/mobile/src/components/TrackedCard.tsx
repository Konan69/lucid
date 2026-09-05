import { View } from "react-native";
import { Check } from "lucide-react-native";
import { useTheme } from "../theme";
import { Card, Label } from "./ui";

// The same tracked-work card and copy as web/src/screen/Conversation.tsx.
export function TrackedCard({
  kind,
  output,
}: {
  kind: string;
  output: unknown;
}) {
  const { colors: c } = useTheme();
  if (kind !== "create_task" && kind !== "schedule_follow_up") return null;
  if (!output || typeof output !== "object") return null;
  const result = output as {
    task?: {
      title?: string;
      assignee?: string;
      dueAt?: string | number | null;
    };
    followUp?: { at?: string | number; repeatEveryMs?: number | null } | null;
  };
  if (typeof result.task?.title !== "string") return null;
  const when = (value: string | number | null | undefined) => {
    if (value == null) return "";
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
  };
  const due = when(result.task.dueAt),
    followUp = when(result.followUp?.at);
  const meta = [
    result.task.assignee && result.task.assignee !== "you"
      ? `Waiting on ${result.task.assignee}`
      : "",
    due ? `Due ${due}` : "",
    followUp
      ? `${result.followUp?.repeatEveryMs ? "Follows up from" : "Follows up"} ${followUp}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card
      style={{
        marginTop: 12,
        flexDirection: "row",
        gap: 12,
        backgroundColor: c["surface-2"],
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c["accent-soft"],
        }}
      >
        <Check size={16} color={c["accent-ink"]} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Label size="micro" tone="ink-4">
          {kind === "create_task"
            ? "Vivid is tracking this"
            : "Vivid will follow up"}
        </Label>
        <Label size="label">{result.task.title}</Label>
        {!!meta && (
          <Label size="micro" tone="ink-3">
            {meta}
          </Label>
        )}
      </View>
    </Card>
  );
}
