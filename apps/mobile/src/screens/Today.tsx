import { useState, useSyncExternalStore } from "react";
import { ScrollView, View, RefreshControl } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Check, Plus, Bell, Circle } from "lucide-react-native";
import { useOpenThread, useWorkspace, type Routes } from "../workspace";
import { useResource } from "../lib/resource";
import { useTheme } from "../theme";
import { type Task, type Notification, when } from "../lib/models";
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

const CURRENT_TIME_REFRESH_MS = 15_000;
const currentTimeListeners = new Set<() => void>();
let currentTime = Date.now();
let currentTimeTimer: ReturnType<typeof setInterval> | null = null;

/** Keeps overdue groups and follow-up defaults on a stable, periodically refreshed snapshot. */
function subscribeCurrentTime(listener: () => void) {
  currentTimeListeners.add(listener);
  if (currentTimeTimer === null) {
    const update = () => {
      currentTime = Date.now();
      for (const currentListener of currentTimeListeners) currentListener();
    };
    update();
    currentTimeTimer = setInterval(update, CURRENT_TIME_REFRESH_MS);
  }
  return () => {
    currentTimeListeners.delete(listener);
    if (currentTimeListeners.size === 0 && currentTimeTimer !== null) {
      clearInterval(currentTimeTimer);
      currentTimeTimer = null;
    }
  };
}

function getCurrentTime() {
  return currentTime;
}

function useCurrentTime() {
  return useSyncExternalStore(subscribeCurrentTime, getCurrentTime, getCurrentTime);
}

export function Today({ navigation }: NativeStackScreenProps<Routes, "Today">) {
  const { api } = useWorkspace();
  const { colors: c } = useTheme();
  const openThread = useOpenThread();
  const tasks = useResource<{ tasks: Task[] }>(api, "/api/tasks");
  const notifications = useResource<{
    notifications: Notification[];
    unreadCount: number;
  }>(api, "/api/notifications");
  const [selectedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState<Task | "new">();
  const [followUp, setFollowUp] = useState<Task>();
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useCurrentTime();
  const tasksData = tasks.data;
  const notificationsData = notifications.data;
  const selected = tasksData === undefined
    ? undefined
    : tasksData.tasks.find((t) => t.id === selectedId);
  type RequestBody = Record<string, string | number | boolean | null | readonly string[]>;
  async function act(path: string, method = "POST", body?: RequestBody) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.request(path, method, body);
      await Promise.all([tasks.refresh(), notifications.refresh()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = tasksData === undefined
    ? []
    : tasksData.tasks.filter((t) =>
        showDone ? t.status !== "open" : t.status === "open",
      );
  const groups = [
    {
      title: "Overdue",
      items: visible.filter(
        (t) => t.status === "open" && t.dueAt !== null && t.dueAt < now,
      ),
    },
    {
      title: showDone ? "Settled" : "On your plate",
      items: visible.filter(
        (t) => t.status !== "open" || t.dueAt === null || t.dueAt >= now,
      ),
    },
  ];
  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Today"
        onBack={() => navigation.goBack()}
        trailing={
          <ControlPill
            icon={Plus}
            accessibilityLabel="Track a task"
            onPress={() => setEditing("new")}
          />
        }
      />
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={tasks.loading}
            onRefresh={() => {
              void tasks.refresh();
              void notifications.refresh();
            }}
          />
        }
        contentContainerStyle={styles.page}
      >
        <Feedback
          error={error || tasks.error || notifications.error}
          retry={() => {
            void tasks.refresh();
            void notifications.refresh();
          }}
        />
        {notificationsData !== undefined && !!notificationsData.unreadCount && (
          <Card>
            <View style={styles.row}>
              <Bell size={18} color={c["ink-2"]} />
              <Label size="headline" style={{ flex: 1 }}>
                While you were away
              </Label>
            </View>
            {notificationsData.notifications
              .filter((n) => !n.readAt)
              .slice(0, 6)
              .map((n) => {
                const conversationId = n.conversationId;
                return (
                  <View key={n.id} style={{ gap: 8 }}>
                    <Label size="footnote">{n.title}</Label>
                    <Label size="label" tone="ink-3">
                      {n.body}
                    </Label>
                    <View style={styles.wrap}>
                      {conversationId && (
                        <ControlPill
                          label="Open conversation"
                          onPress={() => {
                            openThread(conversationId, n.title);
                            void act("/api/notifications/read", "POST", {
                              ids: [n.id],
                            });
                          }}
                        />
                      )}
                      <ControlPill
                        label="Mark read"
                        disabled={busy}
                        onPress={() =>
                          void act("/api/notifications/read", "POST", {
                            ids: [n.id],
                          })
                        }
                      />
                    </View>
                  </View>
                );
              })}
            <ControlPill
              label="Mark all read"
              disabled={busy}
              onPress={() => void act("/api/notifications/read", "POST", {})}
            />
          </Card>
        )}
        <View style={styles.wrap}>
          <ControlPill
            label={showDone ? "Show open tasks" : "Show settled tasks"}
            onPress={() => setShowDone(!showDone)}
          />
        </View>
        {!tasks.loading && !tasks.error && visible.length === 0 && (
          <Empty
            title={showDone ? "A fresh page" : "A little breathing room."}
            detail={
              showDone
                ? "Finished tasks will collect here."
                : "Tell Vivid what to keep an eye on, or add something yourself."
            }
          />
        )}
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <View key={g.title} style={{ gap: 12 }}>
              <Label
                size="label"
                tone={g.title === "Overdue" ? "status-danger" : "ink-3"}
              >
                {g.title}
              </Label>
              {g.items.map((t) => (
                <Card key={t.id}>
                  <View style={styles.row}>
                    <ControlPill
                      icon={t.status === "open" ? Circle : Check}
                      accessibilityLabel={
                        t.status === "open"
                          ? `Complete ${t.title}`
                          : `Reopen ${t.title}`
                      }
                      disabled={busy}
                      onPress={() =>
                        void act(`/api/tasks/${t.id}`, "PATCH", {
                          status: t.status === "open" ? "done" : "open",
                        })
                      }
                    />
                    <View style={{ flex: 1, gap: 4 }}>
                      <Label>{t.title}</Label>
                      <Label size="label" tone="ink-3">
                        {t.assignee ? `With ${t.assignee} · ` : ""}
                        {when(t.dueAt)}
                      </Label>
                    </View>
                  </View>
                  {t.nextFollowUpAt && (
                    <Label size="label" tone="ink-3">
                      Vivid follows up {when(t.nextFollowUpAt)}
                    </Label>
                  )}
                  <ControlPill
                    label="View task"
                    onPress={() => setSelectedId(t.id)}
                  />
                </Card>
              ))}
            </View>
          ))}
      </ScrollView>
      {selected && (
        <Sheet title={selected.title} onClose={() => setSelectedId(undefined)}>
          <Feedback error={error} />
          <Label tone="ink-2">
            {selected.detail || "A small thing worth keeping track of."}
          </Label>
          <Label size="label" tone="ink-3">
            {selected.priority === "urgent" ? "Urgent · " : ""}
            {when(selected.dueAt)}
          </Label>
          <View style={styles.wrap}>
            <ControlPill
              label="Edit"
              onPress={() => {
                setEditing(selected);
                setSelectedId(undefined);
              }}
            />
            <ControlPill
              label="Open conversation"
              onPress={() => {
                openThread(selected.conversationId, selected.title);
                setSelectedId(undefined);
              }}
            />
            {selected.status === "open" && (
              <>
                <ControlPill
                  label="Chase now"
                  disabled={busy}
                  onPress={() =>
                    void act(`/api/tasks/${selected.id}/nudge`, "POST", {})
                  }
                />
                <ControlPill
                  label="Follow up later"
                  onPress={() => {
                    setFollowUp(selected);
                    setSelectedId(undefined);
                  }}
                />
                <ControlPill
                  label="Drop task"
                  disabled={busy}
                  onPress={() =>
                    void act(`/api/tasks/${selected.id}`, "PATCH", {
                      status: "dropped",
                    })
                  }
                />
              </>
            )}
          </View>
          <Label size="headline">Follow-ups</Label>
          {selected.followUps.length === 0 && (
            <Label tone="ink-3">No nudges scheduled yet.</Label>
          )}
          {selected.followUps.map((f) => (
            <Card key={f.id}>
              <Label size="label">
                {when(f.at)} · {f.status}
              </Label>
              <Label tone="ink-3" size="label">
                {f.note || "Check in on this task"}
                {f.repeatEveryMs
                  ? ` · Repeats every ${f.repeatEveryMs / 3_600_000} hours`
                  : ""}
              </Label>
              {f.output && <Label size="label">{f.output}</Label>}
              {f.error && (
                <Label tone="status-danger" size="label">
                  {f.error}
                </Label>
              )}
              <View style={styles.wrap}>
                {f.status !== "running" && f.status !== "cancelled" && (
                  <ControlPill
                    label="Run now"
                    disabled={busy}
                    onPress={() => void act(`/api/follow-ups/${f.id}/run`)}
                  />
                )}
                {f.status === "scheduled" && (
                  <ControlPill
                    label="Cancel"
                    disabled={busy}
                    onPress={() =>
                      void act(`/api/follow-ups/${f.id}`, "PATCH", {
                        status: "cancelled",
                      })
                    }
                  />
                )}
                {["cancelled", "failed"].includes(f.status) && (
                  <ControlPill
                    danger
                    label="Remove"
                    disabled={busy}
                    onPress={() =>
                      void act(`/api/follow-ups/${f.id}`, "DELETE")
                    }
                  />
                )}
              </View>
            </Card>
          ))}
          <ControlPill
            danger
            label="Delete task"
            disabled={busy}
            onPress={() =>
              confirmDelete(
                selected.title,
                () => void act(`/api/tasks/${selected.id}`, "DELETE"),
              )
            }
          />
        </Sheet>
      )}
      {editing && (
        <EditSheet
          title={
            editing === "new" ? "Something to keep an eye on" : "Edit task"
          }
          fields={[
            {
              key: "title",
              label: "What needs doing?",
              value: editing === "new" ? "" : editing.title,
            },
            {
              key: "detail",
              label: "A little context",
              multiline: true,
              value: editing === "new" ? "" : editing.detail,
            },
            {
              key: "assignee",
              label: "Who is it with?",
              value: editing === "new" ? "" : (editing.assignee ?? ""),
            },
            {
              key: "due",
              label: "Due (optional)",
              date: true,
              value:
                editing !== "new" && editing.dueAt
                  ? localDate(editing.dueAt)
                  : "",
            },
            {
              key: "priority",
              label: "How pressing is it?",
              value: editing === "new" ? "normal" : editing.priority,
              options: [
                { label: "Normal", value: "normal" },
                { label: "Urgent", value: "urgent" },
              ],
            },
          ]}
          onClose={() => setEditing(undefined)}
          onSave={async (values) => {
            const dueAt = values.due.trim() ? parseDate(values.due) : null;
            await api.request(
              editing === "new" ? "/api/tasks" : `/api/tasks/${editing.id}`,
              editing === "new" ? "POST" : "PATCH",
              {
                title: values.title,
                detail: values.detail,
                assignee: values.assignee || null,
                dueAt,
                priority: values.priority,
              },
            );
            await tasks.refresh();
          }}
        />
      )}
      {followUp && (
        <EditSheet
          title="Leave the remembering to Vivid"
          fields={[
            {
              key: "at",
              label: "When",
              date: true,
              value: localDate(now + 86_400_000),
            },
            { key: "note", label: "What should Vivid check?", multiline: true },
            {
              key: "repeat",
              label: "How often?",
              value: "once",
              options: [
                { label: "Just once", value: "once" },
                { label: "Every day", value: "daily" },
                { label: "Every week", value: "weekly" },
              ],
            },
          ]}
          onClose={() => setFollowUp(undefined)}
          onSave={async (values) => {
            if (!["once", "daily", "weekly"].includes(values.repeat))
              throw new Error("Choose once, daily, or weekly.");
            await api.request(`/api/tasks/${followUp.id}/follow-ups`, "POST", {
              at: parseDate(values.at),
              note: values.note,
              repeatEveryMs:
                values.repeat === "daily"
                  ? 86_400_000
                  : values.repeat === "weekly"
                    ? 604_800_000
                    : null,
            });
            await tasks.refresh();
          }}
        />
      )}
    </View>
  );
}
export function localDate(value: number) {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function parseDate(value: string) {
  const timestamp = new Date(value.trim().replace(" ", "T")).getTime();
  if (!Number.isFinite(timestamp))
    throw new Error("Use a date and time like 2026-09-15 09:00.");
  return timestamp;
}
