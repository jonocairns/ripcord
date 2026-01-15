import type { AppData, Producer, Router } from "mediasoup/types";
import type {
  CommandDefinition,
  StreamKind,
  TInvokerContext,
} from "@sharkord/shared";

export type { TInvokerContext };

export type ServerEvent =
  | "user:joined"
  | "user:left"
  | "message:created"
  | "message:updated"
  | "message:deleted"
  | "voice:runtime_initialized"
  | "voice:runtime_closed";

export interface EventPayloads {
  "user:joined": {
    userId: number;
    username: string;
  };
  "user:left": {
    userId: number;
    username: string;
  };
  "message:created": {
    messageId: number;
    channelId: number;
    userId: number;
    content: string;
  };
  "message:updated": {
    messageId: number;
    channelId: number;
    userId: number;
    content: string;
  };
  "message:deleted": {
    messageId: number;
    channelId: number;
  };
  "voice:runtime_initialized": {
    channelId: number;
  };
  "voice:runtime_closed": {
    channelId: number;
  };
}

// this API is probably going to change a lot in the future
// so consider it as experimental for now

export interface PluginContext {
  path: string;

  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  error(...args: unknown[]): void;

  events: {
    on<E extends ServerEvent>(
      event: E,
      handler: (payload: EventPayloads[E]) => void | Promise<void>
    ): void;
  };

  actions: {
    voice: {
      getRouter(channelId: number): Router<AppData>;
      addExternalStream(
        channelId: number,
        name: string,
        type: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO,
        producer: Producer
      ): number;
      getListenInfo(): {
        ip: string;
        announcedAddress: string | undefined;
      };
    };
  };

  commands: {
    register<TArgs = void>(command: CommandDefinition<TArgs>): void;
  };
}

export interface UnloadPluginContext
  extends Pick<PluginContext, "log" | "debug" | "error"> {}
