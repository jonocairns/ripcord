import 'ws';

declare module 'ws' {
  interface WebSocket {
    userId?: number;
    token: string;
  }
}

type TCommandMap = {
  [pluginId: string]: {
    [commandName: string]: TCommand;
  };
};

type TCommand = (...args: unknown[]) => Promise<unknown> | unknown;

declare global {
  interface Window {
    __plugins?: {
      commands: TCommandMap;
    };
  }
}

declare module 'bun' {
  interface Env {
    // SHARKORD_ prefixed environment variables
    SHARKORD_PORT?: string;
    SHARKORD_DEBUG?: string;
    SHARKORD_AUTOUPDATE?: string;
    SHARKORD_TRUST_PROXY?: string;
    SHARKORD_TRUSTED_PROXIES?: string;
    SHARKORD_ALLOWED_ORIGINS?: string;
    SHARKORD_HTTP_REQUEST_TIMEOUT_MS?: string;
    SHARKORD_HTTP_HEADERS_TIMEOUT_MS?: string;
    SHARKORD_HTTP_KEEPALIVE_TIMEOUT_MS?: string;
    SHARKORD_HTTP_MAX_HEADERS_COUNT?: string;
    SHARKORD_WS_MAX_PAYLOAD_BYTES?: string;
    SHARKORD_WS_AUTH_TIMEOUT_MS?: string;
    SHARKORD_WS_MAX_CONNECTIONS_PER_IP?: string;
    SHARKORD_WEBRTC_PORT?: string;
    SHARKORD_WEBRTC_ANNOUNCED_ADDRESS?: string;
  }
}
