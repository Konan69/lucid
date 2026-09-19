import { Effect, Schema } from "effect";
import { useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import {
  authorizationAddress,
  connectorNames,
  type ConnectorRequest,
  type ConnectorStatus,
} from "../data/connectorRequests";
import { request as clientRequest, type ClientRequestFailed } from "../data/request";
import { ToolMarks } from "./ToolMarks";

const ConnectorStatusResponseSchema = Schema.Struct({
  connectors: Schema.Array(Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["disconnected", "connecting", "connected", "error"] as const),
  })),
});
const ConnectorStatusResponseJsonSchema = Schema.fromJsonString(ConnectorStatusResponseSchema);
const ConnectorAuthResponseSchema = Schema.Struct({ authUrl: Schema.String });
const ConnectorAuthResponseJsonSchema = Schema.fromJsonString(ConnectorAuthResponseSchema);
const decodeConnectorStatusResponse = Schema.decodeUnknownSync(ConnectorStatusResponseJsonSchema);
const decodeConnectorAuthResponse = Schema.decodeUnknownSync(ConnectorAuthResponseJsonSchema);

class ConnectorActionFailed extends Schema.TaggedError<ConnectorActionFailed>()(
  "ConnectorActionFailed",
  { message: Schema.String, cause: Schema.Defect() },
  { title: "Connector action failed" },
) {}

const readConnectorStatus = Effect.fn("ConnectorRequestCard.readStatus")(function*(
  connector: ConnectorRequest["connector"],
) {
  const data = yield* clientRequest("/api/connectors", decodeConnectorStatusResponse);
  const current = data.connectors.find((item) => item.id === connector);
  return current === undefined ? "disconnected" as const : current.status;
});

export function ConnectorRequestCard({
  request,
  onContinue,
  disabled,
}: {
  request: ConnectorRequest;
  onContinue: () => Promise<void>;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<ConnectorStatus["status"] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authUrl, setAuthUrl] = useState("");
  const name = connectorNames[request.connector];
  useEffect(() => {
    let active = true;
    async function refresh() {
      await Effect.runPromise(readConnectorStatus(request.connector).pipe(Effect.match({
        onFailure: (failure) => {
          if (active) setError(failure.message);
        },
        onSuccess: (nextStatus) => {
          if (active) setStatus(nextStatus);
        },
      })));
    }
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    const timer = setInterval(
      () => {
        if (!document.hidden) void refresh();
      },
      authUrl ? 3000 : 15000,
    );
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [request.connector, authUrl]);

  async function act() {
    setBusy(true);
    setError("");
    // Open synchronously from the click so browser popup blockers don't eat the handoff.
    const popup = status === "connected" ? null : window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    const action: Effect.Effect<
      string | null,
      ClientRequestFailed | ConnectorActionFailed
    > = status === "connected"
      ? Effect.tryPromise({
          try: onContinue,
          catch: (cause) => new ConnectorActionFailed({
            message: "Could not complete the connection. Try again.",
            cause,
          }),
        }).pipe(Effect.as<string | null>(null))
      : clientRequest(
          `/api/connectors/${request.connector}/auth`,
          decodeConnectorAuthResponse,
        ).pipe(
          Effect.flatMap((data) => Effect.try({
            try: () => authorizationAddress(data.authUrl),
            catch: (cause) => new ConnectorActionFailed({
              message: "The connection returned an invalid sign-in address.",
              cause,
            }),
          })),
        );
    await Effect.runPromise(action.pipe(
      Effect.match({
        onFailure: (failure) => {
          if (popup) popup.close();
          setError(failure.message);
        },
        onSuccess: (url) => {
          if (url === null) return;
          setAuthUrl(url);
          if (popup) popup.location.href = url;
        },
      }),
      Effect.ensuring(Effect.sync(() => setBusy(false))),
    ));
  }

  const connected = status === "connected";
  return (
    <div className="my-3 rounded-panel bg-surface-2 px-3.5 py-3 shadow-ring-xs">
      <div className="flex items-center gap-3">
        <ToolMarks tools={[request.connector]} size={28} />
        <span className="min-w-0 flex-1 text-label font-title text-ink">{name}</span>
        {connected && (
          <span className="inline-flex items-center gap-1 text-meta text-success">
            <Check className="size-3.5" />
            Connected
          </span>
        )}
      </div>
      <p className="mt-2 text-label text-ink-3">{request.reason}</p>
      {error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      )}
      {authUrl && !connected && (
        <p role="status" className="mt-2 text-meta text-ink-3">
          Finish signing in, then return here.{" "}
          <a href={authUrl} target="_blank" rel="noreferrer" className="text-accent-ink underline">
            Open sign-in again
          </a>
        </p>
      )}
      <button
        disabled={busy || disabled}
        onClick={() => void act()}
        className="mt-3 inline-flex h-8 items-center gap-2 rounded-control bg-surface-3 px-3 text-label font-title text-ink shadow-ring-xs hover:bg-wash-hover disabled:opacity-50"
      >
        {busy
          ? "Working…"
          : connected
            ? "Continue"
            : authUrl
              ? "Retry connection"
              : `Connect ${name}`}
        {!connected && <ExternalLink className="size-3.5" />}
      </button>
    </div>
  );
}
