import { useEffect, useState } from "react";
import { ToolMarks } from "../ui/ToolMarks";

interface ConnectorInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
}

interface ConnectorStatus {
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  metadata: ConnectorInfo;
}

export function Connectors() {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConnectors();
  }, []);

  async function fetchConnectors() {
    try {
      const res = await fetch("/api/connectors");
      if (res.ok) {
        const data = await res.json() as { connectors: ConnectorStatus[] };
        setConnectors(data.connectors);
      }
    } catch (error) {
      console.error("Failed to fetch connectors:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect(connectorId: string) {
    try {
      const res = await fetch(`/api/connectors/${connectorId}/auth`);
      if (res.ok) {
        const data = await res.json() as { authUrl: string };
        window.location.href = data.authUrl;
      }
    } catch (error) {
      console.error("Failed to get auth URL:", error);
    }
  }

  async function handleDisconnect(connectorId: string) {
    try {
      const res = await fetch(`/api/connectors/${connectorId}`, { method: "DELETE" });
      if (res.ok) {
        fetchConnectors();
      }
    } catch (error) {
      console.error("Failed to disconnect:", error);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-ink-3 text-sm">Loading connectors...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-title text-ink">Connectors</h2>
        <ToolMarks tools={connectors.filter((c) => c.status === "connected").map((c) => c.id)} size={20} />
      </div>
      <p className="text-body text-ink-3">
        Connect your Google services to let Konan work with your email, calendar, and files.
      </p>

      <div className="space-y-3">
        {connectors.map((connector) => (
          <div
            key={connector.id}
            className="flex items-center justify-between rounded-card bg-surface-2 p-4 shadow-ring-xs"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center size-10 rounded-card bg-surface-3 shadow-ring-xs">
                <ToolMarks tools={[connector.id]} size={24} />
              </div>
              <div>
                <div className="text-body font-medium text-ink">{connector.metadata.name}</div>
                <div className="text-caption text-ink-3">{connector.metadata.description}</div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  connector.status === "connected"
                    ? "bg-success-soft text-success"
                    : connector.status === "error"
                      ? "bg-danger-soft text-danger"
                      : "bg-surface-3 text-ink-3"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    connector.status === "connected"
                      ? "bg-success"
                      : connector.status === "error"
                        ? "bg-danger"
                        : "bg-ink-4"
                  }`}
                />
                {connector.status === "connected" ? "Connected" : connector.status === "error" ? "Error" : "Disconnected"}
              </span>

              {connector.status === "connected" ? (
                <button
                  onClick={() => handleDisconnect(connector.id)}
                  className="rounded-card bg-surface-3 px-3 py-1.5 text-xs font-medium text-ink-3 hover:bg-surface-2 hover:text-ink transition-colors"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => handleConnect(connector.id)}
                  className="rounded-card bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
                >
                  Connect
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
