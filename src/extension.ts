import * as vscode from 'vscode';

import {
  canOpenRpcDiff,
  getMigrationRelatedQueriesContent,
  hasComparisonMigration,
  hasMigrationRelatedQueriesContent,
  normalizeSqlForDiff,
  type EmptyStateModel,
  type MigrationKindFilter,
  type MigrationModel,
  type MigrationObjectKind,
  type RpcVersionModel,
} from './migrations';
import { SupabaseMigrationsProvider, type ProviderState } from './provider';

const OPEN_MIGRATION_COMMAND = 'supabaseMigrationsBrowser.openMigration';
const OPEN_SOURCE_MIGRATION_COMMAND = 'supabaseMigrationsBrowser.openSourceMigration';
const OPEN_PREVIOUS_MIGRATION_COMMAND = 'supabaseMigrationsBrowser.openPreviousMigration';
const OPEN_RELATED_QUERIES_COMMAND = 'supabaseMigrationsBrowser.openRelatedQueries';
const REFRESH_MIGRATIONS_COMMAND = 'supabaseMigrationsBrowser.refresh';
const SEARCH_RPCS_COMMAND = 'supabaseMigrationsBrowser.searchRpcs';
const CLEAR_SEARCH_COMMAND = 'supabaseMigrationsBrowser.clearSearch';
const VIEW_ID = 'supabaseMigrationsBrowser.view';
const VIEW_CONTAINER_ID = 'supabaseMigrationsBrowser';
const DIFF_SCHEME = 'supabase-rpc-diff';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SupabaseMigrationsProvider();
  const virtualDocumentProvider = new RpcDiffContentProvider();
  const viewProvider = new SupabaseMigrationsViewProvider(
    provider,
    virtualDocumentProvider,
  );

  context.subscriptions.push(
    provider,
    viewProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      virtualDocumentProvider,
    ),
    vscode.commands.registerCommand(
      REFRESH_MIGRATIONS_COMMAND,
      async (): Promise<void> => {
        await provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      SEARCH_RPCS_COMMAND,
      async (): Promise<void> => {
        await viewProvider.focusSearch();
      },
    ),
    vscode.commands.registerCommand(
      CLEAR_SEARCH_COMMAND,
      async (): Promise<void> => {
        await provider.setSearchQuery('');
      },
    ),
    vscode.commands.registerCommand(
      OPEN_MIGRATION_COMMAND,
      async (model?: MigrationModel): Promise<void> => {
        await openMigrationDiff(model, virtualDocumentProvider);
      },
    ),
    vscode.commands.registerCommand(
      OPEN_SOURCE_MIGRATION_COMMAND,
      async (model?: MigrationModel): Promise<void> => {
        await openSourceMigration(model, virtualDocumentProvider);
      },
    ),
    vscode.commands.registerCommand(
      OPEN_PREVIOUS_MIGRATION_COMMAND,
      async (model?: MigrationModel): Promise<void> => {
        await openPreviousMigration(model, virtualDocumentProvider);
      },
    ),
    vscode.commands.registerCommand(
      OPEN_RELATED_QUERIES_COMMAND,
      async (model?: MigrationModel): Promise<void> => {
        await openRelatedQueries(model, virtualDocumentProvider);
      },
    ),
  );

  void provider.refresh();
}

async function openSourceMigration(
  model: MigrationModel | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!model) {
    return;
  }

  try {
    await openRpcVersion(model.latestVersion, contentProvider);
  } catch {
    void vscode.window.showErrorMessage('Failed to open the latest migration file for the selected Supabase object.');
  }
}

async function openPreviousMigration(
  model: MigrationModel | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!model?.comparisonVersion) {
    return;
  }

  try {
    await openRpcVersion(model.comparisonVersion, contentProvider);
  } catch {
    void vscode.window.showErrorMessage('Failed to open the previous migration file for the selected Supabase object.');
  }
}

async function openRelatedQueries(
  model: MigrationModel | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!model) {
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(
      contentProvider.createDocumentUri(
        `${model.label} related.sql`,
        getMigrationRelatedQueriesContent(model),
      ),
    );

    await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: false,
    });
  } catch {
    void vscode.window.showErrorMessage('Failed to open related queries for the selected Supabase object.');
  }
}

export function deactivate(): void { }

async function openMigrationDiff(
  model: MigrationModel | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!model) {
    return;
  }

  try {
    const latestVersion = model.latestVersion;
    const previousVersion = model.comparisonVersion;

    if (!previousVersion) {
      await openSourceMigration(model, contentProvider);
      return;
    }

    const latestContent = formatRpcVersion(latestVersion);
    const leftUri = contentProvider.createDocumentUri(
      `${model.label} previous.sql`,
      formatRpcVersion(previousVersion),
    );
    const rightUri = contentProvider.createDocumentUri(
      `${model.label} latest.sql`,
      latestContent,
    );

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      buildDiffTitle(model.label, previousVersion, latestVersion),
      {
        preview: true,
        preserveFocus: false,
      },
    );
  } catch {
    void vscode.window.showErrorMessage('Failed to open the Supabase object diff view.');
  }
}

class SupabaseMigrationsViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private shouldFocusSearch = false;
  private viewMessageDisposable?: vscode.Disposable;
  private readonly stateChangeDisposable: vscode.Disposable;

  constructor(
    private readonly provider: SupabaseMigrationsProvider,
    private readonly contentProvider: RpcDiffContentProvider,
  ) {
    this.stateChangeDisposable = this.provider.onDidChangeState((state) => {
      void this.postState(state);
    });
  }

  dispose(): void {
    this.viewMessageDisposable?.dispose();
    this.stateChangeDisposable.dispose();
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = getWebviewHtml();

    this.viewMessageDisposable?.dispose();
    this.viewMessageDisposable = view.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });

    await this.postState(await this.provider.getState());
  }

  async focusSearch(): Promise<void> {
    this.shouldFocusSearch = true;

    for (const command of [`${VIEW_ID}.focus`, `workbench.view.extension.${VIEW_CONTAINER_ID}`]) {
      try {
        await vscode.commands.executeCommand(command);
        break;
      } catch {
        continue;
      }
    }

    await this.postFocusSearch();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    const typedMessage = message as {
      action?: string;
      id?: string;
      type?: string;
      value?: string;
    };

    if (typedMessage.type === 'ready') {
      await this.postState(await this.provider.getState());
      return;
    }

    if (typedMessage.type === 'search' && typeof typedMessage.value === 'string') {
      await this.provider.setSearchQuery(typedMessage.value);
      return;
    }

    if (typedMessage.type === 'filter' && isMigrationKindFilter(typedMessage.value)) {
      await this.provider.setKindFilter(typedMessage.value);
      return;
    }

    if (
      typedMessage.type === 'action' &&
      typeof typedMessage.action === 'string' &&
      typeof typedMessage.id === 'string'
    ) {
      const model = await this.findModelById(typedMessage.id);

      if (!model) {
        return;
      }

      if (typedMessage.action === 'diff') {
        await openMigrationDiff(model, this.contentProvider);
        return;
      }

      if (typedMessage.action === 'latest') {
        await openSourceMigration(model, this.contentProvider);
        return;
      }

      if (typedMessage.action === 'previous') {
        await openPreviousMigration(model, this.contentProvider);
        return;
      }

      if (typedMessage.action === 'related') {
        await openRelatedQueries(model, this.contentProvider);
      }
    }
  }

  private async findModelById(id: string): Promise<MigrationModel | undefined> {
    const state = await this.provider.getState();

    return state.items.find((item) => item.id === id);
  }

  private async postState(state: ProviderState): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage({
      type: 'state',
      payload: buildWebviewState(
        state,
        this.provider.getSearchQuery(),
        this.provider.getKindFilter(),
      ),
    });
    await this.postFocusSearch();
  }

  private async postFocusSearch(): Promise<void> {
    if (!this.shouldFocusSearch || !this.view) {
      return;
    }

    this.shouldFocusSearch = false;
    await this.view.webview.postMessage({ type: 'focusSearch' });
  }
}

async function openRpcVersion(
  version: RpcVersionModel,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  const document = version.sourceKind === 'workspace'
    ? await vscode.workspace.openTextDocument(
      vscode.Uri.parse(version.uriString),
    )
    : await vscode.workspace.openTextDocument(
      contentProvider.createDocumentUri(
        `${version.fileName}`,
        version.fileContent,
      ),
    );
  const startPosition = new vscode.Position(version.startLine, 0);
  const endPosition = new vscode.Position(version.startLine, 0);

  const editor = await vscode.window.showTextDocument(document, {
    preview: true,
    preserveFocus: false,
  });

  editor.selection = new vscode.Selection(startPosition, endPosition);
  editor.revealRange(
    new vscode.Range(startPosition, endPosition),
    vscode.TextEditorRevealType.InCenter,
  );
}

class RpcDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();

  createDocumentUri(fileName: string, content: string): vscode.Uri {
    const documentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.documents.set(documentId, content);

    return vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: `/${fileName}`,
      query: documentId,
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.query) ?? '-- RPC version content unavailable\n';
  }
}

function formatRpcVersion(version: RpcVersionModel): string {
  const objectLabel = getObjectKindLabel(version.kind);
  const headerLines = [
    `-- ${objectLabel}: ${version.qualifiedName}`,
    `-- Migration: ${version.fileName}`,
    `-- Timestamp: ${version.timestamp ?? version.fileName}`,
    `-- Source: ${version.workspaceRelativePath}`,
    '',
  ];

  return `${headerLines.join('\n')}${normalizeSqlForDiff(version.sqlDefinition)}\n`;
}

function buildDiffTitle(
  rpcName: string,
  previousVersion: RpcVersionModel | null,
  latestVersion: RpcVersionModel,
): string {
  const previousLabel = previousVersion?.timestamp ?? 'no previous version';
  const latestLabel = latestVersion.timestamp ?? latestVersion.fileName;

  return `${rpcName}: ${previousLabel} ↔ ${latestLabel}`;
}

function isMigrationKindFilter(value: unknown): value is MigrationKindFilter {
  return value === 'all' || value === 'rpcs' || value === 'views';
}

function getObjectKindLabel(kind: MigrationObjectKind): string {
  return kind === 'view' ? 'View' : 'RPC';
}

type WebviewMigrationItem = {
  canDiff: boolean;
  changeState: 'new' | 'updated' | 'unchanged';
  description: string;
  hasPrevious: boolean;
  hasRelatedQueries: boolean;
  id: string;
  kind: MigrationObjectKind;
  label: string;
  path: string;
  primaryAction: 'diff' | 'latest';
};

type WebviewState = {
  emptyState: EmptyStateModel | null;
  items: WebviewMigrationItem[];
  kindFilter: MigrationKindFilter;
  searchQuery: string;
};

function buildWebviewState(
  state: ProviderState,
  searchQuery: string,
  kindFilter: MigrationKindFilter,
): WebviewState {
  return {
    emptyState: state.emptyState,
    items: state.items.map((model) => {
      const canDiff = canOpenRpcDiff(model);

      return {
        canDiff,
        changeState: model.changeState ?? 'unchanged',
        description: buildItemDescription(model, state.includeWorkspaceName),
        hasPrevious: hasComparisonMigration(model),
        hasRelatedQueries: hasMigrationRelatedQueriesContent(model),
        id: model.id,
        kind: model.kind,
        label: model.label,
        path: model.workspaceRelativePath,
        primaryAction: canDiff ? 'diff' : 'latest',
      };
    }),
    kindFilter,
    searchQuery,
  };
}

function buildItemDescription(
  model: MigrationModel,
  includeWorkspaceName: boolean,
): string {
  const descriptionParts: string[] = [];

  if (includeWorkspaceName && model.workspaceFolderName) {
    descriptionParts.push(model.workspaceFolderName);
  }

  if (model.changeState === 'new') {
    descriptionParts.push('new');
  }

  if (model.changeState === 'updated') {
    descriptionParts.push('updated');
  }

  descriptionParts.push(model.description);

  return descriptionParts.join(' · ');
}

function getWebviewHtml(): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 100%;
      min-width: 0;
      overflow-x: hidden;
    }

    body {
      margin: 0;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }

    button,
    input {
      font: inherit;
    }

    button {
      appearance: none;
      -webkit-appearance: none;
    }

    .layout {
      width: 100%;
      min-height: 100vh;
      overflow-x: hidden;
    }

    .search-shell {
      position: sticky;
      top: 0;
      z-index: 1;
      display: grid;
      gap: 10px;
      padding: 12px;
      background:
        linear-gradient(180deg, var(--vscode-sideBar-background) 0%, color-mix(in srgb, var(--vscode-sideBar-background) 88%, transparent) 100%);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      backdrop-filter: blur(10px);
    }

    .search-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .search-input {
      width: 100%;
      min-width: 0;
      min-height: 30px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
      appearance: none;
      -webkit-appearance: none;
    }

    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .toolbar-button,
    .action-button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      line-height: 1.3;
    }

    .toolbar-button {
      min-height: 30px;
      padding: 8px 10px;
      white-space: nowrap;
    }

    .toolbar-button:disabled {
      cursor: default;
      opacity: 0.6;
    }

    .toolbar-button.active {
      border-color: var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-button-background) 28%, var(--vscode-button-secondaryBackground));
      color: var(--vscode-button-foreground);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent);
    }

    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
    }

    .icon-button svg {
      width: 15px;
      height: 15px;
      fill: currentColor;
    }

    .filter-menu-shell {
      position: relative;
    }

    .filter-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 3;
      min-width: 154px;
      padding: 4px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-dropdown-background, var(--vscode-menu-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-menu-foreground));
      box-shadow: 0 8px 24px color-mix(in srgb, #000 22%, transparent);
    }

    .filter-menu[hidden] {
      display: none;
    }

    .filter-menu button {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: space-between;
      padding: 7px 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .filter-menu button:hover,
    .filter-menu button:focus {
      background: var(--vscode-list-hoverBackground);
      outline: none;
    }

    .filter-menu button[aria-checked="true"] {
      color: var(--vscode-list-highlightForeground, var(--vscode-button-foreground));
      font-weight: 600;
    }

    .filter-menu button[aria-checked="true"]::after {
      content: '✓';
      margin-left: 12px;
    }

    .summary {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .content {
      display: grid;
      gap: 10px;
      padding: 12px;
      min-width: 0;
    }

    .rpc-card,
    .empty-state {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      border-radius: 12px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 92%, transparent), color-mix(in srgb, var(--vscode-sideBar-background) 92%, transparent));
      overflow: hidden;
    }

    .rpc-card.new {
      border-color: color-mix(in srgb, var(--vscode-charts-green) 50%, var(--vscode-sideBar-border, transparent));
    }

    .rpc-card.updated {
      border-color: color-mix(in srgb, var(--vscode-charts-yellow) 55%, var(--vscode-sideBar-border, transparent));
    }

    .rpc-header {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      justify-content: space-between;
      padding: 12px 12px 6px;
      min-width: 0;
    }

    .rpc-title {
      min-width: 0;
      margin: 0;
      font-size: 13px;
      line-height: 1.4;
      font-weight: 600;
      word-break: break-word;
    }

    .rpc-meta,
    .rpc-path {
      padding: 0 12px;
      font-size: 12px;
    }

    .rpc-meta {
      color: var(--vscode-descriptionForeground);
    }

    .rpc-path {
      margin-top: 6px;
      color: var(--vscode-textPreformat-foreground);
      word-break: break-all;
    }

    .rpc-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px;
      min-width: 0;
    }

    .action-button {
      min-height: 26px;
      padding: 6px 10px;
      font-size: 12px;
    }

    .action-button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .badge {
      flex: none;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .badge.new {
      background: color-mix(in srgb, var(--vscode-charts-green) 18%, transparent);
      color: var(--vscode-charts-green);
    }

    .badge.updated {
      background: color-mix(in srgb, var(--vscode-charts-yellow) 22%, transparent);
      color: var(--vscode-charts-yellow);
    }

    .object-kind {
      display: inline-flex;
      align-items: center;
      height: 18px;
      margin-right: 6px;
      padding: 1px 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-badge-background) 16%, transparent);
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .empty-state {
      padding: 14px;
    }

    .empty-title {
      margin: 0 0 6px;
      font-size: 13px;
      font-weight: 600;
    }

    .empty-message {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="layout">
    <header class="search-shell">
      <div class="search-row">
        <input
          id="search-input"
          class="search-input"
          type="search"
          spellcheck="false"
          placeholder="Search RPC/view names, migration paths, SQL, or related queries"
          aria-label="Search Supabase RPCs and views"
        >
        <button id="clear-button" class="toolbar-button" type="button">Clear</button>
        <div class="filter-menu-shell">
          <button
            id="filter-button"
            class="toolbar-button icon-button"
            type="button"
            title="Filter Supabase objects"
            aria-label="Filter Supabase objects"
            aria-haspopup="true"
            aria-expanded="false"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
              <path d="M1.5 3.25A1.25 1.25 0 0 1 2.75 2h10.5a1.25 1.25 0 0 1 .98 2.03L10 9.32v3.43a.75.75 0 0 1-.35.63l-2 1.25A.75.75 0 0 1 6.5 14V9.32L1.52 4.03a1.25 1.25 0 0 1-.02-.78Zm1.28.25 4.99 5.3a.75.75 0 0 1 .2.52v3.33l.53-.33v-3a.75.75 0 0 1 .2-.52l4.23-5.3H2.78Z" />
            </svg>
          </button>
          <div id="filter-menu" class="filter-menu" role="menu" hidden>
            <button type="button" role="menuitemradio" data-filter="all" aria-checked="true">All</button>
            <button type="button" role="menuitemradio" data-filter="rpcs" aria-checked="false">RPCs</button>
            <button type="button" role="menuitemradio" data-filter="views" aria-checked="false">Views</button>
          </div>
        </div>
      </div>
      <div id="summary" class="summary">Loading Supabase objects...</div>
    </header>
    <main id="content" class="content"></main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('search-input');
    const clearButton = document.getElementById('clear-button');
    const filterButton = document.getElementById('filter-button');
    const filterMenu = document.getElementById('filter-menu');
    const summary = document.getElementById('summary');
    const content = document.getElementById('content');
    const state = {
      emptyState: null,
      items: [],
      kindFilter: 'all',
      searchQuery: '',
    };
    let searchTimer = undefined;

    content.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const actionTarget = event.target.closest('[data-action]');

      if (!actionTarget) {
        return;
      }

      const action = actionTarget.getAttribute('data-action');
      const id = actionTarget.getAttribute('data-id');

      if (!action || !id) {
        return;
      }

      vscode.postMessage({
        type: 'action',
        action,
        id,
      });
    });

    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      renderSummary();
      syncClearButton();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        vscode.postMessage({
          type: 'search',
          value: searchInput.value,
        });
      }, 120);
    });

    clearButton.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      syncClearButton();
      renderSummary();
      vscode.postMessage({
        type: 'search',
        value: '',
      });
      searchInput.focus();
    });

    filterButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setFilterMenuOpen(filterMenu.hidden);
    });

    filterMenu.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const menuItem = event.target.closest('[data-filter]');

      if (!menuItem) {
        return;
      }

      const value = menuItem.getAttribute('data-filter');

      if (!isKindFilter(value)) {
        return;
      }

      state.kindFilter = value;
      syncFilterButton();
      renderSummary();
      setFilterMenuOpen(false);
      vscode.postMessage({
        type: 'filter',
        value,
      });
    });

    document.addEventListener('click', () => {
      setFilterMenuOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        setFilterMenuOpen(false);
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.type === 'state') {
        state.emptyState = message.payload.emptyState;
        state.items = message.payload.items;
        state.kindFilter = message.payload.kindFilter;
        state.searchQuery = message.payload.searchQuery;

        if (searchInput.value !== state.searchQuery) {
          searchInput.value = state.searchQuery;
        }

        syncClearButton();
  syncFilterButton();
        render();
        return;
      }

      if (message.type === 'focusSearch') {
        searchInput.focus();
        searchInput.select();
      }
    });

    function syncClearButton() {
      clearButton.disabled = searchInput.value.length === 0;
    }

    function syncFilterButton() {
      const isActive = state.kindFilter !== 'all';

      filterButton.classList.toggle('active', isActive);
      filterButton.setAttribute('aria-expanded', String(!filterMenu.hidden));
      filterButton.title = isActive
        ? 'Filtering by ' + getKindFilterLabel(state.kindFilter)
        : 'Filter Supabase objects';

      for (const menuItem of filterMenu.querySelectorAll('[data-filter]')) {
        menuItem.setAttribute(
          'aria-checked',
          String(menuItem.getAttribute('data-filter') === state.kindFilter),
        );
      }
    }

    function setFilterMenuOpen(isOpen) {
      filterMenu.hidden = !isOpen;
      syncFilterButton();
    }

    function renderSummary() {
      const query = state.searchQuery.trim();
      const noun = getCountNoun(state.kindFilter, state.items.length);
      const filterSuffix = state.kindFilter === 'all'
        ? ''
        : ' · ' + getKindFilterLabel(state.kindFilter) + ' filter';

      if (query) {
        summary.textContent = state.items.length === 1
          ? '1 ' + noun + ' match for "' + query + '"' + filterSuffix
          : String(state.items.length) + ' ' + noun + ' match for "' + query + '"' + filterSuffix;
        return;
      }

      summary.textContent = state.items.length === 1
        ? '1 ' + noun + filterSuffix
        : String(state.items.length) + ' ' + noun + filterSuffix;
    }

    function render() {
      renderSummary();

      if (state.items.length === 0 && state.emptyState) {
        content.innerHTML = [
          '<section class="empty-state">',
          '  <h2 class="empty-title">' + escapeHtml(state.emptyState.label) + '</h2>',
          '  <p class="empty-message">' + escapeHtml(state.emptyState.message) + '</p>',
          '</section>',
        ].join('');
        return;
      }

      content.innerHTML = state.items.map(renderItem).join('');
    }

    function renderItem(item) {
      const badge = item.changeState === 'unchanged'
        ? ''
        : '<span class="badge ' + item.changeState + '">' + escapeHtml(item.changeState) + '</span>';
      const actions = [];

      actions.push(
        '<button class="action-button primary" type="button" data-action="' + escapeHtml(item.primaryAction) + '" data-id="' + escapeHtml(item.id) + '">' +
          (item.primaryAction === 'diff' ? 'Diff' : 'Open latest') +
        '</button>',
      );

      if (item.hasPrevious) {
        actions.push(
          '<button class="action-button" type="button" data-action="previous" data-id="' + escapeHtml(item.id) + '">Open previous</button>',
        );
      }

      if (item.hasRelatedQueries) {
        actions.push(
          '<button class="action-button" type="button" data-action="related" data-id="' + escapeHtml(item.id) + '">Related queries</button>',
        );
      }

      return [
        '<article class="rpc-card ' + item.changeState + '">',
        '  <header class="rpc-header">',
        '    <h2 class="rpc-title"><span class="object-kind">' + escapeHtml(getObjectKindLabel(item.kind)) + '</span>' + escapeHtml(item.label) + '</h2>',
        '    ' + badge,
        '  </header>',
        '  <div class="rpc-meta">' + escapeHtml(item.description) + '</div>',
        '  <div class="rpc-path">' + escapeHtml(item.path) + '</div>',
        '  <div class="rpc-actions">' + actions.join('') + '</div>',
        '</article>',
      ].join('');
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function isKindFilter(value) {
      return value === 'all' || value === 'rpcs' || value === 'views';
    }

    function getKindFilterLabel(kindFilter) {
      if (kindFilter === 'rpcs') {
        return 'RPCs';
      }

      if (kindFilter === 'views') {
        return 'Views';
      }

      return 'All';
    }

    function getObjectKindLabel(kind) {
      return kind === 'view' ? 'View' : 'RPC';
    }

    function getCountNoun(kindFilter, count) {
      if (kindFilter === 'rpcs') {
        return count === 1 ? 'RPC function' : 'RPC functions';
      }

      if (kindFilter === 'views') {
        return count === 1 ? 'view' : 'views';
      }

      return count === 1 ? 'Supabase object' : 'Supabase objects';
    }

    syncClearButton();
    syncFilterButton();
    render();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}