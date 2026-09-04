export type ConnectorId = "gmail" | "calendar" | "drive";

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectorMetadata {
  id: ConnectorId;
  name: string;
  description: string;
  icon: string;
  scopes: string[];
}

export interface ConnectorCredential {
  id: string;
  connectorId: ConnectorId;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  createdAt: number;
}

export interface Connector {
  metadata(): ConnectorMetadata;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<ConnectorCredential>;
  refreshCredential(credential: ConnectorCredential): Promise<ConnectorCredential>;
  revokeCredential(credentialId: string): Promise<void>;
}

export interface ConnectorTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, credential: ConnectorCredential): Promise<unknown>;
}

export interface ConnectorWithTools extends Connector {
  tools(): ConnectorTool[];
}
