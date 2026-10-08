// Messages exchanged between DashboardPanel (extension host) and src/webview/dashboard.ts.
// Type-only: imported by both sides, erased from both bundles.
import type { CatalogModel, ModelOverride, ProviderConfig, ProviderStatus, RouteConfig, RouteView } from "./types";

export type ProviderView = Omit<ProviderConfig, "apiKey"> & ProviderStatus;

export interface DashboardSettings {
  testConcurrency: number;
  providerConcurrency: number;
  cacheTtlHours: number;
  showReasoning: boolean;
  toolCheck: "full" | "basic";
  budgetLimitUsd?: number;
}

export interface DashboardState {
  providers: ProviderView[];
  models: CatalogModel[];
  routes: RouteView[];
  overrides: Record<string, ModelOverride>;
  discovered: boolean;
  verifying: { done: number; total: number; working: number; failed: number } | null;
  spend: number;
  settings: DashboardSettings;
}

export type DashboardTab = "models" | "providers" | "routes" | "settings";

/** Host → webview. */
export type HostMessage =
  | { type: "state"; state: DashboardState }
  | { type: "focus"; tab?: DashboardTab; editProvider?: string; addProvider?: boolean; editModel?: string }
  | { type: "connectionResult"; reqId: string; ok: boolean; latencyMs: number; modelCount?: number; error?: string }
  | { type: "saveResult"; ok: boolean; name?: string; error?: string }
  | { type: "localScanResult"; found: { name: string; url: string; api: string }[] };

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" | "refresh" | "cancelVerify" | "clearCache" | "pruneCache" | "clearFailed" | "exportConfig" | "importConfig" | "exportStats" | "scanLocalServers" | "openSettings" | "showLogs" | "resetStats" | "autoRoutes" }
  | { type: "curateTop"; limit?: number }
  | { type: "verify"; keys?: string[]; force?: boolean }
  | { type: "setSelected"; keys: string[]; selected: boolean }
  | { type: "setSelectionExactly"; keys: string[] }
  | { type: "testConnection"; reqId: string; provider: Partial<ProviderConfig>; originalName: string | null; apiKey?: string }
  | { type: "saveProvider"; provider: Partial<ProviderConfig>; originalName: string | null; apiKey?: string }
  | { type: "toggleProvider"; name: string; enabled: boolean }
  | { type: "deleteProvider" | "pullOllama" | "setApiKey"; name: string }
  | { type: "updateSetting"; key: keyof DashboardSettings; value: unknown }
  | { type: "setOverride"; key: string; override?: ModelOverride }
  | { type: "saveRoutes"; routes: RouteConfig[] };
