export function normalizeGatewayBase(raw: string): string;

export type GatewaySearchTokens = {
  spotifyToken?: string;
  yandexToken?: string;
  vkToken?: string;
  soundcloudClientId?: string;
};

export type FlowGatewayClientConfig = {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
};

export type FlowGatewayClient = {
  normalizeGatewayBase: typeof normalizeGatewayBase;
  getBase(): string;
  health(): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }>;
  search(
    q: string,
    source: string,
    tokens?: GatewaySearchTokens,
  ): Promise<{
    ok: boolean;
    tracks: unknown[];
    mode?: string;
    error?: string;
  }>;
  resolve(
    track: Record<string, unknown>,
    tokens?: GatewaySearchTokens,
  ): Promise<{ ok: boolean; url?: string; error?: string }>;
  validateYandex(token: string): Promise<{ ok: boolean; message: string }>;
  validateVk(token: string): Promise<{ ok: boolean; message: string }>;
  probeSavedTokens(tokens?: GatewaySearchTokens): Promise<{
    health: unknown;
    yandex: unknown;
    vk: unknown;
  }>;
};

export function createFlowGatewayClient(cfg: FlowGatewayClientConfig): FlowGatewayClient;
