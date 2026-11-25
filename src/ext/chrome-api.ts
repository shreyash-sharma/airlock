/**
 * The slice of the Chrome extension API that AIRLOCK uses, written as structural types. The extension code takes a
 * ChromeLike instead of the global, so unit tests pass a fake and no @types/chrome dependency is needed.
 */

export interface ChromeEvent<F extends (...args: never[]) => unknown> {
  addListener(listener: F): void;
  removeListener(listener: F): void;
}

export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number };
  frameId?: number;
}

export interface PortLike {
  name: string;
  sender?: SenderLike;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
}

export interface RegisteredScript {
  id: string;
  matches?: string[];
  js?: string[];
  runAt?: "document_start" | "document_end" | "document_idle";
  world?: "ISOLATED" | "MAIN";
  allFrames?: boolean;
  persistAcrossSessions?: boolean;
}

export interface ChromeLike {
  runtime: {
    id: string;
    connect(info: { name: string }): PortLike;
    getURL(path: string): string;
    onConnect: ChromeEvent<(port: PortLike) => void>;
    onMessage: ChromeEvent<(message: unknown, sender: SenderLike, sendResponse: (response: unknown) => void) => boolean | void>;
    onInstalled: ChromeEvent<() => void>;
    onStartup: ChromeEvent<() => void>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    onChanged: ChromeEvent<(changes: Record<string, { newValue?: unknown }>, area: string) => void>;
  };
  scripting: {
    registerContentScripts(scripts: RegisteredScript[]): Promise<void>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredScript[]>;
  };
  permissions: {
    contains(query: { origins: string[] }): Promise<boolean>;
    onAdded: ChromeEvent<() => void>;
    onRemoved: ChromeEvent<() => void>;
  };
}
