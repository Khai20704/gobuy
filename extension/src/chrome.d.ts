declare const __API_ORIGIN__: string
declare const __WEB_ORIGIN__: string
declare const chrome: {
  runtime: {
    id: string; getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(listener: (message: unknown, sender: { id?: string; url?: string; tab?: unknown }, reply: (value: unknown) => void) => boolean | void): void };
  };
  storage: { session: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>; remove(key: string | string[]): Promise<void> } };
  tabs: { query(options: { active: boolean; currentWindow: boolean }): Promise<{ id?: number; url?: string; windowId: number }[]>; create(options: { url: string }): Promise<unknown> };
  windows: { getCurrent(): Promise<{ id?: number }> };
  scripting: { executeScript<T>(options: { target: { tabId: number }; func: () => T }): Promise<{ result?: T }[]> };
  sidePanel: { open(options: { windowId: number }): Promise<void> };
}
