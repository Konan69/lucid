import { useState } from "react";
import { ScrollView, View, RefreshControl } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Plus, Pause, Play, Repeat2 } from "lucide-react-native";
import { RoutineListResponse } from "@vivid/contracts";
import { useOpenThread, useWorkspace, type Routes } from "../workspace";
import { useResource } from "../lib/resource";
import { type Routine, when } from "../lib/models";
import {
  Card,
  ControlPill,
  EditSheet,
  Empty,
  Feedback,
  Header,
  Label,
  Sheet,
  confirmDelete,
  styles,
} from "../components/ui";
import { templates } from "../../../web/src/data/routines";

export function Routines({
  navigation,
}: NativeStackScreenProps<Routes, "Routines">) {
  const { api } = useWorkspace();
  const open = useOpenThread();
  const resource = useResource(api, "/api/routines", RoutineListResponse);
  const [selectedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState<Partial<Routine>>();
  const [gallery, setGallery] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const data = resource.data;
  const selected = data === undefined
    ? undefined
    : data.routines.find((r) => r.id === selectedId);
  type RequestBody = Record<string, string | number | boolean | null> | FormData;
  async function act(id: string, method: string, body?: RequestBody, suffix = "") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.request(`/api/routines/${id}${suffix}`, method, body);
      await resource.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Routines"
        onBack={() => navigation.goBack()}
        trailing={
          <ControlPill
            icon={Plus}
            accessibilityLabel="New routine"
            onPress={() => setEditing({})}
          />
        }
      />
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={resource.loading}
            onRefresh={resource.refresh}
          />
        }
        contentContainerStyle={styles.page}
      >
        <Feedback error={error || resource.error} retry={resource.refresh} />
        <ControlPill
          icon={Repeat2}
          label="A little inspiration"
          onPress={() => setGallery(true)}
        />
        {!resource.loading &&
          !resource.error &&
          data !== undefined &&
          data.routines.length === 0 && (
            <Empty
              title="One less thing to remember."
              detail="A morning brief, a weekly check-in. Tell Vivid what to repeat and when."
            />
          )}
        {data !== undefined && data.routines.map((r) => (
          <Card key={r.id}>
            <Label size="headline">{r.name}</Label>
            <Label size="label" tone="ink-3">
              {r.enabled ? `Next up ${when(r.nextRunAt)}` : "Taking a pause"}
            </Label>
            <Label numberOfLines={3} tone="ink-2">
              {r.prompt}
            </Label>
            {r.lastMissedAt && (
              <Label tone="status-danger" size="label">
                Missed a run {when(r.lastMissedAt)}
              </Label>
            )}
            <View style={styles.wrap}>
              <ControlPill
                label="View routine"
                onPress={() => setSelectedId(r.id)}
              />
              <ControlPill
                icon={r.enabled ? Pause : Play}
                accessibilityLabel={
                  r.enabled ? `Pause ${r.name}` : `Resume ${r.name}`
                }
                disabled={busy}
                onPress={() => void act(r.id, "PATCH", { enabled: !r.enabled })}
              />
            </View>
          </Card>
        ))}
      </ScrollView>
      {selected && (
        <Sheet title={selected.name} onClose={() => setSelectedId(undefined)}>
          <Feedback error={error} />
          <Label>{selected.prompt}</Label>
          <Label tone="ink-3" size="label">
            {selected.cron} · {selected.timezone}
          </Label>
          <View style={styles.wrap}>
            <ControlPill
              primary
              label="Run now"
              disabled={busy}
              onPress={() => void act(selected.id, "POST", undefined, "/run")}
            />
            <ControlPill
              label="Edit routine"
              onPress={() => {
                setEditing(selected);
                setSelectedId(undefined);
              }}
            />
          </View>
          <Label size="headline">What happened</Label>
          {!selected.runs.length && (
            <Label tone="ink-3">Your first run will appear here.</Label>
          )}
          {selected.runs.map((run) => (
            <Card key={run.id}>
              <Label size="label">
                {when(run.startedAt)} · {run.status}
              </Label>
              {run.output && (
                <Label numberOfLines={6} size="label">
                  {run.output}
                </Label>
              )}
              {run.error && (
                <Label tone="status-danger" size="label">
                  {run.error}
                </Label>
              )}
              <ControlPill
                label="Open conversation"
                onPress={() => {
                  open(run.conversationId, selected.name);
                  setSelectedId(undefined);
                }}
              />
              {run.status === "failed" && (
                <ControlPill
                  label="Try again"
                  disabled={busy}
                  onPress={() =>
                    void act(selected.id, "POST", undefined, "/run")
                  }
                />
              )}
            </Card>
          ))}
          <ControlPill
            danger
            label="Delete routine"
            disabled={busy}
            onPress={() =>
              confirmDelete(
                selected.name,
                () => void act(selected.id, "DELETE"),
              )
            }
          />
        </Sheet>
      )}
      {gallery && (
        <Sheet title="Make a little room" onClose={() => setGallery(false)}>
          <Label tone="ink-3">
            Ideas to make your own. Availability depends on your connected
            tools.
          </Label>
          {templates.map((t) => (
            <Card key={t.id}>
              <Label size="headline">{t.name}</Label>
              <Label tone="ink-2">{t.summary}</Label>
              <Label size="label" tone="ink-3">
                {t.trigger}
              </Label>
              <ControlPill
                label="Use as a starting point"
                onPress={() => {
                  setGallery(false);
                  setEditing({ name: t.name, prompt: t.actions.join(". ") });
                }}
              />
            </Card>
          ))}
        </Sheet>
      )}
      {editing && (
        <EditSheet
          title={editing.id ? "Edit routine" : "Give it a rhythm"}
          fields={[
            { key: "name", label: "Call it something", value: editing.name },
            {
              key: "prompt",
              label: "What should Vivid do?",
              value: editing.prompt,
              multiline: true,
            },
            {
              key: "cron",
              label: "When should I check in?",
              value: editing.cron ?? "0 9 * * 1-5",
              options: [
                { label: "Weekdays at 9", value: "0 9 * * 1-5" },
                { label: "Every day at 9", value: "0 9 * * *" },
                { label: "Mondays at 9", value: "0 9 * * 1" },
                { label: "Every hour", value: "0 * * * *" },
              ],
              allowCustom: true,
            },
            {
              key: "timezone",
              label: "Timezone",
              value:
                editing.timezone ??
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          ]}
          onClose={() => setEditing(undefined)}
          onSave={async (values) => {
            await api.request(
              editing.id ? `/api/routines/${editing.id}` : "/api/routines",
              editing.id ? "PATCH" : "POST",
              values,
            );
            await resource.refresh();
          }}
        />
      )}
    </View>
  );
}
