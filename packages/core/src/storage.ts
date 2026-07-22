/**
 * Storage Adapter Interface
 *
 * Defines the contract for session storage implementations.
 * Allows custom storage backends (localStorage, sessionStorage, IndexedDB, etc.)
 */

export class StorageError extends Error {
  constructor(
    message: string,
    public code:
      | "quota_exceeded"
      | "not_available"
      | "parse_error"
      | "unknown" = "unknown",
    cause?: unknown,
  ) {
    super(message);
    this.name = "StorageError";
    if (cause) {
      this.cause = cause;
    }
  }
}

export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
  isAvailable(): boolean;
}

function getGlobalStorage(
  key: "localStorage" | "sessionStorage",
): Storage | null {
  if (typeof globalThis !== "undefined" && key in globalThis) {
    const candidate = (globalThis as Record<string, unknown>)[key];
    if (
      candidate !== null &&
      candidate !== undefined &&
      typeof (candidate as Record<string, unknown>).getItem === "function"
    ) {
      return candidate as Storage;
    }
  }
  return null;
}

function isStorageAvailable(type: "local" | "session"): boolean {
  if (typeof window === "undefined") {
    try {
      const storage = getGlobalStorage("localStorage");
      if (storage) {
        const testKey = "__storage_test__";
        storage.setItem(testKey, testKey);
        storage.removeItem(testKey);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  try {
    const storage =
      type === "local" ? window.localStorage : window.sessionStorage;
    const testKey = "__storage_test__";
    storage.setItem(testKey, testKey);
    storage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the Storage object regardless of runtime (browser, jsdom, node, deno). */
function resolveLocalStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return getGlobalStorage("localStorage");
}

function resolveSessionStorage(): Storage | null {
  if (typeof window !== "undefined" && window.sessionStorage) {
    return window.sessionStorage;
  }
  return getGlobalStorage("sessionStorage");
}

export class LocalStorageAdapter implements StorageAdapter {
  private prefix: string;
  private _available: boolean | null = null;

  constructor(prefix = "") {
    this.prefix = prefix;
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private getStorage(): Storage | null {
    return resolveLocalStorage();
  }

  isAvailable(): boolean {
    if (this._available === null) {
      this._available = isStorageAvailable("local");
    }
    return this._available;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) return null;

    try {
      const store = this.getStorage();
      if (!store) return null;
      const item = store.getItem(this.getKey(key));
      if (item === null) return null;
      return JSON.parse(item) as T;
    } catch (e) {
      throw new StorageError(
        `Failed to parse storage item: ${key}`,
        "parse_error",
        e,
      );
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.isAvailable()) {
      throw new StorageError("LocalStorage is not available", "not_available");
    }

    try {
      const store = this.getStorage();
      if (!store) {
        throw new StorageError(
          "LocalStorage is not available",
          "not_available",
        );
      }
      store.setItem(this.getKey(key), JSON.stringify(value));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        throw new StorageError(
          `Storage quota exceeded for key: ${key}`,
          "quota_exceeded",
          e,
        );
      }
      throw new StorageError(
        `Failed to set storage item: ${key}`,
        "unknown",
        e,
      );
    }
  }

  async remove(key: string): Promise<void> {
    if (!this.isAvailable()) return;
    const store = this.getStorage();
    if (store) store.removeItem(this.getKey(key));
  }

  async clear(): Promise<void> {
    if (!this.isAvailable()) return;
    const store = this.getStorage();
    if (!store) return;

    const prefix = this.prefix || "";
    if (!prefix) {
      store.clear();
      return;
    }

    const keys = Object.keys(store);
    for (const k of keys) {
      if (k.startsWith(prefix)) {
        store.removeItem(k);
      }
    }
  }

  async has(key: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return (await this.get(key)) !== null;
  }
}

export class SessionStorageAdapter implements StorageAdapter {
  private prefix: string;
  private _available: boolean | null = null;

  constructor(prefix = "") {
    this.prefix = prefix;
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  isAvailable(): boolean {
    if (this._available === null) {
      this._available = isStorageAvailable("session");
    }
    return this._available;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) return null;

    try {
      const item = window.sessionStorage.getItem(this.getKey(key));
      if (item === null) return null;
      return JSON.parse(item) as T;
    } catch (e) {
      throw new StorageError(
        `Failed to parse storage item: ${key}`,
        "parse_error",
        e,
      );
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.isAvailable()) {
      throw new StorageError(
        "SessionStorage is not available",
        "not_available",
      );
    }

    try {
      window.sessionStorage.setItem(this.getKey(key), JSON.stringify(value));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        throw new StorageError(
          `Storage quota exceeded for key: ${key}`,
          "quota_exceeded",
          e,
        );
      }
      throw new StorageError(
        `Failed to set storage item: ${key}`,
        "unknown",
        e,
      );
    }
  }

  async remove(key: string): Promise<void> {
    if (!this.isAvailable()) return;
    window.sessionStorage.removeItem(this.getKey(key));
  }

  async clear(): Promise<void> {
    if (!this.isAvailable()) return;

    const prefix = this.prefix || "";
    if (!prefix) {
      window.sessionStorage.clear();
      return;
    }

    const keys = Object.keys(window.sessionStorage);
    for (const k of keys) {
      if (k.startsWith(prefix)) {
        window.sessionStorage.removeItem(k);
      }
    }
  }

  async has(key: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return (await this.get(key)) !== null;
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  private store: Map<string, unknown> = new Map();

  isAvailable(): boolean {
    return true;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;

    if (typeof value === "string") {
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    }

    return value as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(
      key,
      typeof value === "object" ? JSON.stringify(value) : value,
    );
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}

export class NoopStorageAdapter implements StorageAdapter {
  isAvailable(): boolean {
    return false;
  }

  async get<T>(_key: string): Promise<T | null> {
    return null;
  }

  async set<T>(_key: string, _value: T): Promise<void> {}

  async remove(_key: string): Promise<void> {}

  async clear(): Promise<void> {}

  async has(_key: string): Promise<boolean> {
    return false;
  }
}

export function createStorageAdapter(
  type: "local" | "session" | "memory" | "none",
  prefix = "",
): StorageAdapter {
  switch (type) {
    case "local":
      return new LocalStorageAdapter(prefix);
    case "session":
      return new SessionStorageAdapter(prefix);
    case "memory":
      return new MemoryStorageAdapter();
    case "none":
    default:
      return new NoopStorageAdapter();
  }
}
