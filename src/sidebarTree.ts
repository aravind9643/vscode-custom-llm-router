import * as vscode from "vscode";
import { ModelEngine } from "./modelEngine";
import { CatalogModel, ProviderStatus } from "./types";

export type RouterNode = { kind: "provider"; name: string } | { kind: "model"; key: string };

const STATUS_ORDER: Record<string, number> = { working: 0, testing: 1, untested: 2, failed: 3 };

/** Activity-bar tree: providers → models, with checkboxes that add a model to the Copilot picker. */
export class RouterTreeProvider implements vscode.TreeDataProvider<RouterNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RouterNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _disposables: vscode.Disposable[] = [];
  readonly view: vscode.TreeView<RouterNode>;

  constructor(private readonly _engine: ModelEngine) {
    this.view = vscode.window.createTreeView("llmRouter.providers", {
      treeDataProvider: this,
      showCollapseAll: true,
      manageCheckboxStateManually: true,
    });
    this._disposables.push(
      this.view,
      this._onDidChangeTreeData,
      _engine.onDidChange(() => this._refresh()),
      this.view.onDidChangeCheckboxState((e) => this._onCheckbox(e))
    );
  }

  private _refresh() {
    const p = this._engine.verifyProgress;
    this.view.message = p ? `Verifying models… ${p.done}/${p.total}` : undefined;
    const selected = this._engine.getCopilotModels().length;
    this.view.description = selected ? `${selected} in Copilot` : undefined;
    this._onDidChangeTreeData.fire();
  }

  private async _onCheckbox(e: vscode.TreeCheckboxChangeEvent<RouterNode>) {
    const on: string[] = [];
    const off: string[] = [];
    for (const [node, state] of e.items) {
      if (node.kind !== "model") continue;
      (state === vscode.TreeItemCheckboxState.Checked ? on : off).push(node.key);
    }
    if (on.length) await this._engine.store.setSelected(on, true);
    if (off.length) await this._engine.store.setSelected(off, false);
    // A model only reaches Copilot once verified, so test freshly selected ones right away.
    const untested = on.map((k) => this._engine.getModel(k)).filter((m): m is CatalogModel => m?.status === "untested");
    if (untested.length) void this._engine.verify(untested);
  }

  getChildren(node?: RouterNode): RouterNode[] {
    if (!node) {
      if (!this._engine.isDiscovered && this._engine.store.getProviders().length) {
        void this._engine.ensureDiscovered();
      }
      return this._engine.getProviderStatuses().map((s) => ({ kind: "provider", name: s.name }));
    }
    if (node.kind === "provider") {
      return [...this._engine.getModels(node.name)]
        .sort(
          (a, b) =>
            Number(b.selected) - Number(a.selected) ||
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) ||
            a.name.localeCompare(b.name)
        )
        .map((m) => ({ kind: "model", key: m.key }));
    }
    return [];
  }

  getTreeItem(node: RouterNode): vscode.TreeItem {
    if (node.kind === "provider") {
      const s = this._engine.getProviderStatuses().find((p) => p.name === node.name);
      return s ? this._providerItem(s) : new vscode.TreeItem(node.name);
    }
    const m = this._engine.getModel(node.key);
    return m ? this._modelItem(m) : new vscode.TreeItem(node.key);
  }

  getParent(node: RouterNode): RouterNode | undefined {
    if (node.kind === "model") return { kind: "provider", name: node.key.slice(0, node.key.indexOf("::")) };
    return undefined;
  }

  private _providerItem(s: ProviderStatus): vscode.TreeItem {
    const models = this._engine.getModels(s.name);
    const item = new vscode.TreeItem(
      s.name,
      s.enabled && models.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.id = `provider:${s.name}`;
    item.contextValue = `provider.${s.enabled ? "enabled" : "disabled"}${s.kind === "ollama" ? ".ollama" : ""}${s.needsKey ? ".needskey" : ""}`;

    const inCopilot = models.filter((m) => m.selected && m.status === "working").length;
    if (!s.enabled) {
      item.description = "disabled";
      item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
    } else if (s.online === undefined) {
      item.description = "connecting…";
      item.iconPath = new vscode.ThemeIcon("loading~spin");
    } else if (s.online) {
      item.description = inCopilot ? `${inCopilot} of ${models.length} in Copilot` : `${models.length} models`;
      item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
    } else if (s.needsKey) {
      item.description = "API key needed";
      item.iconPath = new vscode.ThemeIcon("key", new vscode.ThemeColor("editorWarning.foreground"));
    } else {
      item.description = "offline";
      item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(s.name)}**\n\n`);
    md.appendMarkdown(`$(link) \`${s.endpointUrl}\`\n\n`);
    if (s.online) md.appendMarkdown(`$(pass) Online · ${s.latencyMs ?? "?"}ms · ${s.modelCount} models\n\n`);
    if (s.error) md.appendMarkdown(`$(error) ${escapeMd(s.error)}\n\n`);
    md.appendMarkdown(
      s.keySource === "secret" ? "$(lock) API key in secure storage" : s.keySource === "settings" ? "$(warning) API key stored in plain-text settings" : "$(unlock) No API key"
    );
    if (s.plaintextSecretHeaders?.length) md.appendMarkdown(`\n\n$(warning) Header ${s.plaintextSecretHeaders.join(", ")} stored in plain text — edit and save the provider to secure it`);
    const spend = this._engine.getModels(s.name).reduce((n, m) => n + (m.stats?.costUsd || 0), 0);
    if (spend > 0) md.appendMarkdown(`\n\n$(credit-card) ~$${spend.toFixed(spend < 1 ? 4 : 2)} estimated spend`);
    item.tooltip = md;
    return item;
  }

  private _modelItem(m: CatalogModel): vscode.TreeItem {
    const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
    item.id = `model:${m.key}`;
    item.contextValue = `model.${m.status}`;
    item.checkboxState = {
      state: m.selected ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: m.selected ? "Shown in the Copilot model picker" : "Add to the Copilot model picker",
    };

    const caps = [m.caps.tools && "tools", m.caps.vision && "vision", m.caps.reasoning && "reasoning"].filter(Boolean).join(" · ");
    switch (m.status) {
      case "working":
        item.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
        item.description = `${m.latencyMs}ms${caps ? ` · ${caps}` : ""}`;
        break;
      case "testing":
        item.iconPath = new vscode.ThemeIcon("loading~spin");
        item.description = "testing…";
        break;
      case "failed":
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
        item.description = m.selected ? "failed · hidden from Copilot" : "failed";
        break;
      default:
        item.iconPath = new vscode.ThemeIcon("circle-outline");
        item.description = m.selected ? "untested · not yet in Copilot" : caps || "untested";
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(m.name)}**  \n\`${m.id}\`\n\n`);
    const ctxSource = m.contextSource === "server" ? "reported by server" : m.contextSource === "override" ? "your override" : "estimated";
    md.appendMarkdown(`Context ${Math.round(m.contextWindow / 1000)}k (${ctxSource}) · max output ${Math.round(m.maxOutputTokens / 1000)}k\n\n`);
    const tools = m.toolSupport === "called" ? "calls tools" : m.toolSupport === "accepted" ? "accepts tools but did not call one" : m.toolSupport === "unsupported" ? "no tool calling" : "tools not checked";
    if (m.status === "working") md.appendMarkdown(`$(pass) Working · ${m.latencyMs}ms · ${tools}\n\n`);
    if (m.pricing) md.appendMarkdown(`$(credit-card) $${m.pricing.inputPerM}/M in · $${m.pricing.outputPerM}/M out${m.pricing.source === "list" ? " (list price)" : m.pricing.source === "override" ? " (your price)" : ""}\n\n`);
    if (m.stats?.requests) {
      const speed = [m.stats.ttftMs !== undefined && `first token ${m.stats.ttftMs}ms`, m.stats.tokensPerSec && `${m.stats.tokensPerSec} tok/s`].filter(Boolean).join(" · ");
      const cost = m.stats.costUsd ? ` · ~$${m.stats.costUsd.toFixed(m.stats.costUsd < 1 ? 4 : 2)}` : "";
      md.appendMarkdown(`$(graph) ${m.stats.requests} chat request${m.stats.requests === 1 ? "" : "s"}${m.stats.failures ? `, ${m.stats.failures} failed` : ""}${speed ? ` · ${speed}` : ""}${cost}\n\n`);
    }
    if (m.error) md.appendMarkdown(`$(error) ${escapeMd(m.error)}\n\n`);
    if (m.testedAt) md.appendMarkdown(`Tested ${timeAgo(m.testedAt)}`);
    item.tooltip = md;
    return item;
  }

  dispose() {
    this._disposables.forEach((d) => d.dispose());
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, "\\$&");
}

export function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
