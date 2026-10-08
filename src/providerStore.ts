import * as vscode from "vscode";
import { ModelOverride, ProviderConfig, RouteConfig, modelKey } from "./types";
import { isSecretHeaderName } from "./endpoints";
import type { Auth } from "./transports/types";

const SECTION = "customLlmRouter";
const secretId = (providerName: string) => `${SECTION}.apiKey.${providerName}`;
const headersId = (providerName: string) => `${SECTION}.headers.${providerName}`;
/** Placeholder the dashboard shows for a stored secret header value; saving it back keeps the value. */
export const SECRET_SENTINEL = "••••••";

/**
 * Single source of truth for user configuration: providers live in settings,
 * API keys and secret header values live in SecretStorage, and the Copilot selection
 * is an opt-in list of model keys.
 */
export class ProviderStore {
  private _secretNames = new Set<string>();
  private _secretHeaderNames = new Map<string, string[]>();

  constructor(private readonly _secrets: vscode.SecretStorage) {}

  private get _config() {
    return vscode.workspace.getConfiguration(SECTION);
  }

  /** Loads which providers have stored secrets so status queries can answer synchronously. */
  public async init(): Promise<void> {
    this._secretNames.clear();
    this._secretHeaderNames.clear();
    for (const p of this.getProviders()) {
      if (await this._secrets.get(secretId(p.name))) this._secretNames.add(p.name);
      const headers = Object.keys(await this._getSecretHeaders(p.name));
      if (headers.length) this._secretHeaderNames.set(p.name, headers);
    }
  }

  public getProviders(): ProviderConfig[] {
    const list = this._config.get<ProviderConfig[]>("providers") || [];
    return list.filter((p) => p && typeof p.name === "string" && typeof p.endpointUrl === "string");
  }

  public getEnabledProviders(): ProviderConfig[] {
    return this.getProviders().filter((p) => p.enabled !== false && p.endpointUrl.trim().length > 0);
  }

  public findProvider(name: string): ProviderConfig | undefined {
    return this.getProviders().find((p) => p.name === name);
  }

  public async getApiKey(p: ProviderConfig): Promise<string | undefined> {
    return (await this._secrets.get(secretId(p.name))) || p.apiKey || undefined;
  }

  /** Everything needed to authenticate a request to this provider. */
  public async getAuth(p: ProviderConfig): Promise<Auth> {
    return { apiKey: await this.getApiKey(p), secretHeaders: await this._getSecretHeaders(p.name) };
  }

  private async _getSecretHeaders(name: string): Promise<Record<string, string>> {
    const raw = await this._secrets.get(headersId(name));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  public keySource(p: ProviderConfig): "secret" | "settings" | "none" {
    if (this._secretNames.has(p.name)) return "secret";
    return p.apiKey ? "settings" : "none";
  }

  public secretHeaderNames(p: ProviderConfig): string[] {
    return this._secretHeaderNames.get(p.name) || [];
  }

  /** Credential-like headers still stored as plain text in settings (moved on the next save). */
  public plaintextSecretHeaders(p: ProviderConfig): string[] {
    return Object.keys(p.headers || {}).filter(isSecretHeaderName);
  }

  /** Stores just the API key (used by the "Enter API key" prompt). */
  public async setApiKey(name: string, key: string): Promise<void> {
    if (key.trim()) {
      await this._secrets.store(secretId(name), key.trim());
      this._secretNames.add(name);
    } else {
      await this._secrets.delete(secretId(name));
      this._secretNames.delete(name);
    }
  }

  /**
   * Creates or updates a provider.
   * @param apiKey `undefined` keeps the current key, `""` clears it, any other string replaces it.
   * Header values whose names look like credentials are moved to SecretStorage; the value
   * `SECRET_SENTINEL` keeps the stored one.
   */
  public async saveProvider(originalName: string | undefined, input: ProviderConfig, apiKey?: string): Promise<void> {
    const providers = this.getProviders();
    const name = input.name.trim();
    if (!name) throw new Error("Provider name is required.");
    if (providers.some((p) => p.name === name && p.name !== originalName)) {
      throw new Error(`A provider named "${name}" already exists.`);
    }

    const idx = originalName !== undefined ? providers.findIndex((p) => p.name === originalName) : -1;
    const previous = idx >= 0 ? providers[idx] : undefined;

    // Resolve secrets to keep before touching anything, so renames carry them over.
    let key: string | undefined;
    if (apiKey !== undefined) key = apiKey.trim() || undefined;
    else if (previous) key = await this.getApiKey(previous);
    const previousSecretHeaders = previous ? await this._getSecretHeaders(previous.name) : {};
    const { plain, secret } = splitHeaders(input.headers, previousSecretHeaders);

    const next: ProviderConfig = { ...input, name, endpointUrl: input.endpointUrl.trim() };
    delete next.apiKey; // keys never go back into settings
    if (Object.keys(plain).length) next.headers = plain;
    else delete next.headers;
    if (idx >= 0) providers[idx] = next;
    else providers.push(next);

    if (previous && previous.name !== name) {
      await this._secrets.delete(secretId(previous.name));
      await this._secrets.delete(headersId(previous.name));
      this._secretNames.delete(previous.name);
      this._secretHeaderNames.delete(previous.name);
      await this._renameSelection(previous.name, name);
      await this._renameKeyedSettings(previous.name, name);
    }
    await this.setApiKey(name, key || "");
    await this._storeSecretHeaders(name, secret);

    await this._config.update("providers", providers, vscode.ConfigurationTarget.Global);
  }

  private async _storeSecretHeaders(name: string, secret: Record<string, string>) {
    if (Object.keys(secret).length) {
      await this._secrets.store(headersId(name), JSON.stringify(secret));
      this._secretHeaderNames.set(name, Object.keys(secret));
    } else {
      await this._secrets.delete(headersId(name));
      this._secretHeaderNames.delete(name);
    }
  }

  public async deleteProvider(name: string): Promise<void> {
    const providers = this.getProviders().filter((p) => p.name !== name);
    await this._secrets.delete(secretId(name));
    await this._secrets.delete(headersId(name));
    this._secretNames.delete(name);
    this._secretHeaderNames.delete(name);
    const selection = this.getSelection();
    const kept = [...selection].filter((k) => !k.startsWith(`${name}::`));
    if (kept.length !== selection.size) await this.setSelection(kept);
    await this._config.update("providers", providers, vscode.ConfigurationTarget.Global);
  }

  public async setProviderEnabled(name: string, enabled: boolean): Promise<void> {
    const providers = this.getProviders().map((p) => (p.name === name ? { ...p, enabled } : p));
    await this._config.update("providers", providers, vscode.ConfigurationTarget.Global);
  }

  /** Replaces the whole provider list (used by import). Keys and secret headers are moved to SecretStorage. */
  public async replaceProviders(list: ProviderConfig[]): Promise<void> {
    const clean: ProviderConfig[] = [];
    for (const p of list) {
      if (!p || typeof p.name !== "string" || typeof p.endpointUrl !== "string") continue;
      const { apiKey, ...rest } = p;
      if (apiKey) await this.setApiKey(p.name, apiKey);
      const { plain, secret } = splitHeaders(p.headers, {});
      if (Object.keys(secret).length) await this._storeSecretHeaders(p.name, secret);
      if (Object.keys(plain).length) rest.headers = plain;
      else delete rest.headers;
      clean.push(rest);
    }
    await this._config.update("providers", clean, vscode.ConfigurationTarget.Global);
  }

  // ---- Copilot selection (opt-in) ----

  public getSelection(): Set<string> {
    return new Set(this._config.get<string[]>("copilotModels") || []);
  }

  public hasSelectionSetting(): boolean {
    const info = this._config.inspect<string[]>("copilotModels");
    return info?.globalValue !== undefined || info?.workspaceValue !== undefined;
  }

  public async setSelection(keys: Iterable<string>): Promise<void> {
    const sorted = [...new Set(keys)].sort();
    await this._config.update("copilotModels", sorted, vscode.ConfigurationTarget.Global);
  }

  public async setSelected(keys: string[], selected: boolean): Promise<void> {
    const selection = this.getSelection();
    for (const k of keys) {
      if (selected) selection.add(k);
      else selection.delete(k);
    }
    await this.setSelection(selection);
  }

  /** Legacy opt-out list from v1.0.x, only read during migration. */
  public getLegacyDisabledIds(): Set<string> {
    return new Set(this._config.get<string[]>("disabledModelIds") || []);
  }

  private async _renameSelection(from: string, to: string): Promise<void> {
    const prefix = `${from}::`;
    const selection = [...this.getSelection()].map((k) =>
      k.startsWith(prefix) ? modelKey(to, k.slice(prefix.length)) : k
    );
    await this.setSelection(selection);
  }

  // ---- Per-model overrides ----

  public getOverrides(): Record<string, ModelOverride> {
    return { ...(this._config.get<Record<string, ModelOverride>>("modelOverrides") || {}) };
  }

  /** `undefined` (or an empty object) removes the override. */
  public async setOverride(key: string, override: ModelOverride | undefined): Promise<void> {
    const all = this.getOverrides();
    const clean: ModelOverride = {};
    if (override?.name?.trim()) clean.name = override.name.trim();
    if (Number(override?.contextWindow) > 0) clean.contextWindow = Math.round(Number(override!.contextWindow));
    if (Number(override?.maxOutputTokens) > 0) clean.maxOutputTokens = Math.round(Number(override!.maxOutputTokens));
    if (typeof override?.toolCalling === "boolean") clean.toolCalling = override.toolCalling;
    if (typeof override?.vision === "boolean") clean.vision = override.vision;
    for (const k of ["inputPerM", "outputPerM"] as const) {
      const v = Number(override?.[k]);
      if (override?.[k] !== undefined && Number.isFinite(v) && v >= 0) clean[k] = v;
    }
    if (Object.keys(clean).length) all[key] = clean;
    else delete all[key];
    await this._config.update("modelOverrides", all, vscode.ConfigurationTarget.Global);
  }

  // ---- Routes ----

  public getRoutes(): RouteConfig[] {
    const list = this._config.get<RouteConfig[]>("routes") || [];
    return list.filter((r) => r && typeof r.name === "string" && r.name.trim() && Array.isArray(r.models));
  }

  public async saveRoutes(routes: RouteConfig[]): Promise<void> {
    const seen = new Set<string>();
    const clean = routes
      .map((r) => ({ name: String(r.name || "").trim(), models: [...new Set((r.models || []).filter((k) => typeof k === "string"))] }))
      .filter((r) => r.name && !seen.has(r.name) && seen.add(r.name));
    await this._config.update("routes", clean, vscode.ConfigurationTarget.Global);
  }

  private async _renameKeyedSettings(from: string, to: string): Promise<void> {
    const prefix = `${from}::`;
    const rekey = (k: string) => (k.startsWith(prefix) ? modelKey(to, k.slice(prefix.length)) : k);
    const overrides = this.getOverrides();
    if (Object.keys(overrides).some((k) => k.startsWith(prefix))) {
      const next: Record<string, ModelOverride> = {};
      for (const [k, v] of Object.entries(overrides)) next[rekey(k)] = v;
      await this._config.update("modelOverrides", next, vscode.ConfigurationTarget.Global);
    }
    const routes = this.getRoutes();
    if (routes.some((r) => r.models.some((k) => k.startsWith(prefix)))) {
      await this.saveRoutes(routes.map((r) => ({ ...r, models: r.models.map(rekey) })));
    }
  }

  // ---- Settings ----

  public get concurrency(): number {
    return Math.min(25, Math.max(1, this._config.get<number>("testConcurrency") || 8));
  }

  public get cacheTtlMs(): number {
    const hours = this._config.get<number>("cacheTtlHours") || 48;
    return Math.max(1, hours) * 60 * 60 * 1000;
  }

  /** Parallel checks against one remote provider, to stay under its rate limits. Local servers use the global limit. */
  public get providerConcurrency(): number {
    return Math.min(25, Math.max(1, this._config.get<number>("providerConcurrency") || 3));
  }

  /** "full" = chat + tool call check, "basic" = chat only (half the requests). */
  public get toolCheck(): "full" | "basic" {
    return this._config.get<string>("toolCheck") === "basic" ? "basic" : "full";
  }

  public get showReasoning(): boolean {
    return this._config.get<boolean>("showReasoning") !== false;
  }

  public async updateSetting(key: "testConcurrency" | "providerConcurrency" | "cacheTtlHours" | "showReasoning" | "toolCheck", value: unknown) {
    await this._config.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

function splitHeaders(headers: Record<string, string> | undefined, previousSecret: Record<string, string>) {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!k.trim() || typeof v !== "string") continue;
    if (isSecretHeaderName(k)) {
      const value = v === SECRET_SENTINEL ? previousSecret[k] : v;
      if (value) secret[k] = value;
    } else {
      plain[k] = v;
    }
  }
  return { plain, secret };
}
