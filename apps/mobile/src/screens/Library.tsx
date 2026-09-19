import { useState } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  Upload,
} from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { openDocument } from "../lib/documents";
import { useOpenThread, useWorkspace, type Routes } from "../workspace";
import { useResource } from "../lib/resource";
import { useTheme } from "../theme";
import { type Document, type Folder } from "../lib/models";
import {
  Card,
  ControlPill,
  EditSheet,
  Empty,
  Feedback,
  Field,
  Header,
  Label,
  Sheet,
  confirmDelete,
  styles,
} from "../components/ui";

export function Library({
  navigation,
}: NativeStackScreenProps<Routes, "Library">) {
  const { api, createThread } = useWorkspace();
  const { colors: c } = useTheme();
  const open = useOpenThread();
  const [path, setPath] = useState<Folder[]>([]);
  const currentFolder = path.at(-1);
  const folderId = currentFolder === undefined ? undefined : currentFolder.id;
  const resource = useResource<{ documents: Document[]; folders: Folder[] }>(
    api,
    `/api/library${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`,
  );
  const allFolders = useResource<{ folders: Folder[] }>(
    api,
    "/api/library/folders",
  );
  const [selected, setSelected] = useState<
    { kind: "file"; item: Document } | { kind: "folder"; item: Folder }
  >();
  const [edit, setEdit] = useState<{
    title: string;
    fields: { key: string; label: string; value?: string }[];
    save: (v: Record<string, string>) => Promise<void>;
  }>();
  const [move, setMove] = useState<typeof selected>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const data = resource.data;
  const folderData = allFolders.data;
  const [results, setResults] = useState<
    {
      chunkId: string;
      documentId: string;
      filename: string;
      page: number | null;
      text: string;
    }[]
  >();
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await resource.refresh();
      await allFolders.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "text/plain", "text/markdown"],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (asset.size && asset.size > 10 * 1024 * 1024)
      throw new Error("Choose a file smaller than 10 MB.");
    const form = new FormData();
    form.append(
      "file",
      Platform.OS === "web" && asset.file ? asset.file : new File(asset.uri),
      asset.name,
    );
    if (folderId) form.append("folderId", folderId);
    await api.request("/api/library", "POST", form);
    setResults(undefined);
  }
  function endpoint(value: NonNullable<typeof selected>) {
    return value.kind === "file"
      ? `/api/library/${value.item.id}`
      : `/api/library/folders/${value.item.id}`;
  }
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={currentFolder === undefined ? "Library" : currentFolder.name}
        onBack={() => {
          setResults(undefined);
          if (path.length) setPath((p) => p.slice(0, -1));
          else navigation.goBack();
        }}
        trailing={
          <ControlPill
            icon={Upload}
            accessibilityLabel="Upload a document"
            disabled={busy}
            onPress={() => void action(upload)}
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
        {busy && (
          <Label size="label" tone="ink-3">
            One moment…
          </Label>
        )}
        <View style={styles.wrap}>
          <ControlPill
            icon={FolderPlus}
            label="New folder"
            onPress={() =>
              setEdit({
                title: "A place for related things",
                fields: [{ key: "name", label: "Folder name" }],
                save: async (v) => {
                  await api.request("/api/library/folders", "POST", {
                    name: v.name,
                    parentId: folderId ?? null,
                  });
                },
              })
            }
          />
        </View>
        <Field
          accessibilityLabel="Search the Library"
          placeholder="Find something in your files…"
          value={query}
          onChangeText={setQuery}
        />
        <View style={styles.wrap}>
          <ControlPill
            label="Search files"
            disabled={busy || query.trim().length < 2}
            onPress={() =>
              void action(async () => {
                const body = await api.request<{
                  results: NonNullable<typeof results>;
                }>("/api/library/search", "POST", {
                  query: query.trim(),
                  folderId,
                  limit: 8,
                });
                setResults(body.results);
              })
            }
          />
          {results && (
            <ControlPill
              label="Clear search"
              onPress={() => {
                setResults(undefined);
                setQuery("");
              }}
            />
          )}
        </View>
        {results !== undefined && results.length === 0 && (
          <Label tone="ink-3">No passages found. Try a different phrase.</Label>
        )}
        {results !== undefined && results.map((result) => (
          <Card key={result.chunkId}>
            <Label size="label">
              {result.filename}
              {result.page ? ` · page ${result.page}` : ""}
            </Label>
            <Label size="label" tone="ink-2">
              {result.text}
            </Label>
            <ControlPill
              label="Open source"
              disabled={busy}
              onPress={() =>
                void action(() =>
                  openDocument(
                    api,
                    `/api/library/${result.documentId}/content`,
                    result.filename,
                  ),
                )
              }
            />
          </Card>
        ))}
        <Label size="label" tone="ink-3">
          PDF, Markdown, and text · up to 10 MB
        </Label>
        {!resource.loading &&
          !resource.error &&
          data !== undefined &&
          data.documents.length === 0 &&
          data.folders.length === 0 && (
            <Empty
              title="Put a little context here."
              detail="Notes, briefs, the document you always have to explain. Vivid can read them when you ask."
            />
          )}
        {data !== undefined && data.folders.map((f) => (
          <Card key={f.id}>
            <View style={styles.row}>
              <FolderIcon size={22} color={c["ink-2"]} />
              <Label style={{ flex: 1 }}>{f.name}</Label>
              <Label size="micro" tone="ink-3">
                {f.itemCount} items
              </Label>
            </View>
            <View style={styles.wrap}>
              <ControlPill
                label="Open folder"
                onPress={() => {
                  setResults(undefined);
                  setPath((p) => [...p, f]);
                }}
              />
              <ControlPill
                label="Manage"
                onPress={() => setSelected({ kind: "folder", item: f })}
              />
            </View>
          </Card>
        ))}
        {data !== undefined && data.documents.map((d) => (
          <Card key={d.id}>
            <View style={styles.row}>
              <FileText size={22} color={c["ink-2"]} />
              <Label style={{ flex: 1 }}>{d.name}</Label>
            </View>
            <Label
              size="label"
              tone={d.status === "failed" ? "status-danger" : "ink-3"}
            >
              {Math.max(1, Math.round(d.size / 1024))} KB ·{" "}
              {d.status === "ready"
                ? "Ready to read"
                : d.status === "failed"
                  ? (d.error ?? "Could not read this file")
                  : "Getting it ready…"}
            </Label>
            <ControlPill
              label="View document"
              onPress={() => setSelected({ kind: "file", item: d })}
            />
          </Card>
        ))}
      </ScrollView>
      {selected && (
        <Sheet
          title={selected.item.name}
          onClose={() => setSelected(undefined)}
        >
          <Feedback error={error} />
          {selected.kind === "file" && (
            <>
              <Label tone="ink-2">
                {selected.item.preview || "Your document is in the Library."}
              </Label>
              <ControlPill
                primary
                label="Ask Vivid about this"
                disabled={busy || selected.item.status !== "ready"}
                onPress={() =>
                  void action(async () => {
                    const t = await createThread(
                      `Search the Library and answer a question about “${selected.item.name}”: `,
                    );
                    setSelected(undefined);
                    open(t.id, t.title, t.draft);
                  })
                }
              />
              <ControlPill
                label="Open original"
                disabled={busy}
                onPress={() =>
                  void action(async () => {
                    await openDocument(
                      api,
                      `/api/library/${selected.item.id}/content`,
                      selected.item.name,
                    );
                  })
                }
              />
            </>
          )}
          <ControlPill
            label="Rename"
            onPress={() => {
              const value = selected;
              setSelected(undefined);
              setEdit({
                title: "Rename",
                fields: [
                  { key: "name", label: "Name", value: value.item.name },
                ],
                save: async (v) => {
                  await api.request(endpoint(value), "PATCH", { name: v.name });
                },
              });
            }}
          />
          <ControlPill
            label="Move"
            onPress={() => {
              setMove(selected);
              setSelected(undefined);
            }}
          />
          <ControlPill
            danger
            label={`Delete ${selected.kind === "file" ? "document" : "folder"}`}
            disabled={busy}
            onPress={() =>
              confirmDelete(
                selected.item.name,
                () =>
                  void action(async () => {
                    await api.request(endpoint(selected), "DELETE");
                    setSelected(undefined);
                    setResults(undefined);
                  }),
              )
            }
          />
        </Sheet>
      )}
      {move && (
        <Sheet
          title={`Move ${move.item.name}`}
          onClose={() => setMove(undefined)}
        >
          <Feedback error={error || allFolders.error} />
          {[
            { id: "", name: "Library" },
            ...(folderData === undefined ? [] : folderData.folders).filter(
              (f) => f.id !== move.item.id,
            ),
          ].map((f) => (
            <ControlPill
              key={f.id}
              label={f.name}
              disabled={busy}
              onPress={() =>
                void action(async () => {
                  await api.request(
                    endpoint(move),
                    "PATCH",
                    move.kind === "file"
                      ? { folderId: f.id || null }
                      : { parentId: f.id || null },
                  );
                  setMove(undefined);
                  setResults(undefined);
                })
              }
            />
          ))}
        </Sheet>
      )}
      {edit && (
        <EditSheet
          title={edit.title}
          fields={edit.fields}
          onClose={() => setEdit(undefined)}
          onSave={async (values) => {
            await edit.save(values);
            setResults(undefined);
            await resource.refresh();
            await allFolders.refresh();
          }}
        />
      )}
    </View>
  );
}
