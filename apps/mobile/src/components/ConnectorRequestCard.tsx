import { useState } from "react";
import { Linking, View } from "react-native";
import { Check, ExternalLink } from "lucide-react-native";
import { ConnectionListResponse } from "@vivid/contracts";
import { useWorkspace } from "../workspace";
import { useResource } from "../lib/resource";
import { Card, ControlPill, Label } from "./ui";
import { ToolMark } from "./ToolMark";
import {
  authorizationAddress,
  connectorNames,
  type ConnectorRequest,
} from "../../../web/src/data/connectorRequests";

export function ConnectorRequestCard({
  request,
  onContinue,
  disabled,
}: {
  request: ConnectorRequest;
  onContinue: () => Promise<void>;
  disabled: boolean;
}) {
  const { api } = useWorkspace();
  const resource = useResource(api, "/api/connectors", ConnectionListResponse);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const connected = resource.data === undefined
    ? false
    : resource.data.connectors.some(
        (item) => item.id === request.connector && item.status === "connected",
      );
  const name = connectorNames[request.connector];
  async function act() {
    setBusy(true);
    setError("");
    try {
      if (connected) await onContinue();
      else {
        const data = await api.request<{ authUrl: unknown }>(
          `/api/connectors/${request.connector}/auth`,
        );
        const url = authorizationAddress(data.authUrl);
        await Linking.openURL(url);
        setAuthUrl(url);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ marginVertical: 8, gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        <ToolMark id={request.connector} size={28} />
        <Label size="label" style={{ flex: 1, fontWeight: "500" }}>
          {name}
        </Label>
        {connected && (
          <Label size="micro" tone="status-success">
            Connected
          </Label>
        )}
      </View>
      <Label size="label" tone="ink-3">
        {request.reason}
      </Label>
      {!!(error || resource.error) && (
        <Label size="micro" tone="status-danger">
          {error || resource.error}
        </Label>
      )}
      {!!authUrl && !connected && (
        <>
          <Label size="micro" tone="ink-3">
            Finish signing in, then return here.
          </Label>
          <ControlPill
            label="Open sign-in again"
            onPress={() => {
              void Linking.openURL(authUrl).catch(() =>
                setError("Could not open sign-in. Try again."),
              );
            }}
          />
        </>
      )}
      <ControlPill
        icon={connected ? Check : ExternalLink}
        label={
          busy
            ? "Working…"
            : connected
              ? "Continue"
              : authUrl
                ? "Retry connection"
                : `Connect ${name}`
        }
        disabled={busy || disabled}
        onPress={() => void act()}
      />
    </Card>
  );
}
