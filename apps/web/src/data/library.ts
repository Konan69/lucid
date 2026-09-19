import { Effect, Option, Schema } from "effect";
import { ClientRequestFailed, emptyResponse, request } from "./request";

export type Program<Value> = Effect.Effect<Value, ClientRequestFailed>;

export type LibraryDocument = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: "processing" | "ready" | "failed";
  error: string | null;
  preview: string;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
};

export type LibraryFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
};

export type SearchResult = {
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  text: string;
  score: number;
};

export type DialogState =
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: LibraryFolder }
  | { kind: "move-folder"; folder: LibraryFolder }
  | { kind: "rename-file"; document: LibraryDocument }
  | { kind: "move-file"; document: LibraryDocument };

export type DialogResult = { folder?: LibraryFolder; document?: LibraryDocument };

const LibraryDocumentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  status: Schema.Literals(["processing", "ready", "failed"] as const),
  error: Schema.NullOr(Schema.String),
  preview: Schema.String,
  chunkCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  folderId: Schema.NullOr(Schema.String),
});
const LibraryFolderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  itemCount: Schema.Number,
});
const SearchResultSchema = Schema.Struct({
  chunkId: Schema.String,
  documentId: Schema.String,
  filename: Schema.String,
  page: Schema.NullOr(Schema.Number),
  text: Schema.String,
  score: Schema.Number,
});
const LibraryListResponseSchema = Schema.Struct({
  documents: Schema.Array(LibraryDocumentSchema),
  folders: Schema.Array(LibraryFolderSchema),
});
const FoldersResponseSchema = Schema.Struct({ folders: Schema.Array(LibraryFolderSchema) });
const SearchResponseSchema = Schema.Struct({ results: Schema.Array(SearchResultSchema) });
const DocumentResponseSchema = Schema.Struct({ document: LibraryDocumentSchema });
const FolderResponseSchema = Schema.Struct({ folder: LibraryFolderSchema });
const UploadResponseSchema = Schema.Struct({ document: LibraryDocumentSchema });
const ErrorResponseSchema = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
const decodeLibraryListResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(LibraryListResponseSchema),
);
const decodeFoldersResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(FoldersResponseSchema),
);
const decodeSearchResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(SearchResponseSchema),
);
const decodeDocumentResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(DocumentResponseSchema),
);
const decodeFolderResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(FolderResponseSchema),
);
const decodeUploadResponse = Schema.decodeUnknownOption(UploadResponseSchema);
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponseSchema);

/** Loads the current folder and the complete folder index used by move dialogs. */
export const load = Effect.fn("Library.load")(function*(folderId: string | null) {
  const path = folderId === null
    ? "/api/library"
    : `/api/library?folderId=${encodeURIComponent(folderId)}`;
  const [body, folderBody] = yield* Effect.all([
    request(path, decodeLibraryListResponse),
    request("/api/library/folders", decodeFoldersResponse),
  ]);
  return {
    documents: [...body.documents],
    folders: [...body.folders],
    allFolders: [...folderBody.folders],
  };
});

/** Uploads one file while reporting byte progress from XMLHttpRequest. */
export const upload = Effect.fn("Library.upload")(function*(
  file: File,
  folderId: string | null,
  onProgress: (progress: number) => void,
) {
  return yield* Effect.callback<LibraryDocument, ClientRequestFailed>((resume) => {
    const form = new FormData();
    form.set("file", file);
    if (folderId !== null) form.set("folderId", folderId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/library");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => resume(Effect.fail(new ClientRequestFailed({
      path: "/api/library",
      status: null,
      message: "Upload failed",
      cause: xhr.statusText,
    })));
    xhr.onload = () => {
      const body = decodeUploadResponse(xhr.response);
      if (xhr.status >= 200 && xhr.status < 300 && Option.isSome(body)) {
        resume(Effect.succeed(body.value.document));
        return;
      }
      const failure = decodeErrorResponse(xhr.response);
      const message = Option.isSome(failure) ? failure.value.error : undefined;
      resume(Effect.fail(new ClientRequestFailed({
        path: "/api/library",
        status: xhr.status,
        message: message ?? `Upload failed (${xhr.status})`,
        cause: xhr.response,
      })));
    };
    xhr.send(form);
  });
});

/** Searches ready Library documents in the current folder scope. */
export const search = Effect.fn("Library.search")(function*(
  query: string,
  folderId: string | null,
) {
  const response = yield* request("/api/library/search", decodeSearchResponse, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, limit: 8, folderId }),
  });
  return [...response.results];
});

/** Deletes one Library document. */
export const removeDocument = Effect.fn("Library.removeDocument")(function*(id: string) {
  yield* request(`/api/library/${encodeURIComponent(id)}`, emptyResponse, { method: "DELETE" });
});

/** Deletes one empty Library folder. */
export const removeFolder = Effect.fn("Library.removeFolder")(function*(id: string) {
  yield* request(`/api/library/folders/${encodeURIComponent(id)}`, emptyResponse, { method: "DELETE" });
});

/** Reads one Library document selected from search results. */
export const readDocument = Effect.fn("Library.readDocument")(function*(id: string) {
  const response = yield* request(`/api/library/${encodeURIComponent(id)}`, decodeDocumentResponse);
  return response.document;
});

/** Applies one create, rename, or move dialog operation. */
export const saveDialog = Effect.fn("Library.saveDialog")(function*(
  state: DialogState,
  name: string,
  destination: string,
  currentFolderId: string | null,
) {
  if (state.kind === "new-folder") {
    const body = yield* request("/api/library/folders", decodeFolderResponse, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parentId: currentFolderId }),
    });
    return { folder: body.folder } satisfies DialogResult;
  }
  if (state.kind === "rename-folder" || state.kind === "move-folder") {
    const body = yield* request(
      `/api/library/folders/${encodeURIComponent(state.folder.id)}`,
      decodeFolderResponse,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state.kind === "rename-folder" ? { name } : { parentId: destination || null }),
      },
    );
    return { folder: body.folder } satisfies DialogResult;
  }
  const body = yield* request(
    `/api/library/${encodeURIComponent(state.document.id)}`,
    decodeDocumentResponse,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.kind === "rename-file" ? { name } : { folderId: destination || null }),
    },
  );
  return { document: body.document } satisfies DialogResult;
});
