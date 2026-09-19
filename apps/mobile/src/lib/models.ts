export type Thread = {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  archived: boolean;
};
export type FollowUp = {
  id: string;
  at: number;
  note: string;
  repeatEveryMs: number | null;
  status: "scheduled" | "running" | "fired" | "failed" | "cancelled";
  output: string | null;
  error: string | null;
};
export type Task = {
  id: string;
  title: string;
  detail: string;
  status: "open" | "done" | "dropped";
  priority: "normal" | "urgent";
  assignee: string | null;
  dueAt: number | null;
  conversationId: string;
  nextFollowUpAt: number | null;
  followUps: readonly FollowUp[];
};
export type Notification = {
  id: string;
  title: string;
  body: string;
  conversationId: string | null;
  readAt: number | null;
};
export type Routine = {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastMissedAt: number | null;
  runs: readonly {
    id: string;
    conversationId: string;
    status: string;
    output: string | null;
    error: string | null;
    startedAt: number;
  }[];
};
export type Document = {
  id: string;
  name: string;
  size: number;
  status: string;
  preview: string;
  error: string | null;
  folderId: string | null;
};
export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  itemCount: number;
};
export const when = (value: number | null) =>
  value == null
    ? "No date set"
    : new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
