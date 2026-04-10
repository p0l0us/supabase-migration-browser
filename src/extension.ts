import * as vscode from 'vscode';

import {
  getLatestMigrationRelatedQueriesContent,
  normalizeSqlForDiff,
  type RpcVersionModel,
} from './migrations';
import {
  MigrationTreeItem,
  RPC_TREE_ITEM_SCHEME,
  SupabaseMigrationsProvider,
} from './provider';

const OPEN_MIGRATION_COMMAND = 'supabaseMigrationsBrowser.openMigration';
const OPEN_SOURCE_MIGRATION_COMMAND = 'supabaseMigrationsBrowser.openSourceMigration';
const OPEN_PREVIOUS_MIGRATION_COMMAND = 'supabaseMigrationsBrowser.openPreviousMigration';
const OPEN_RELATED_QUERIES_COMMAND = 'supabaseMigrationsBrowser.openRelatedQueries';
const REFRESH_MIGRATIONS_COMMAND = 'supabaseMigrationsBrowser.refresh';
const SEARCH_RPCS_COMMAND = 'supabaseMigrationsBrowser.searchRpcs';
const CLEAR_SEARCH_COMMAND = 'supabaseMigrationsBrowser.clearSearch';
const VIEW_ID = 'supabaseMigrationsBrowser.view';
const DIFF_SCHEME = 'supabase-rpc-diff';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SupabaseMigrationsProvider();
  const decorationProvider = new RpcFileDecorationProvider();
  const virtualDocumentProvider = new RpcDiffContentProvider();
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    provider,
    treeView,
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      virtualDocumentProvider,
    ),
    provider.onDidChangeMessage((message) => {
      treeView.message = message;
      treeView.description = provider.getSearchQuery().trim()
        ? `Search: ${provider.getSearchQuery().trim()}`
        : undefined;
    }),
    vscode.commands.registerCommand(
      REFRESH_MIGRATIONS_COMMAND,
      async (): Promise<void> => {
        await provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      SEARCH_RPCS_COMMAND,
      async (): Promise<void> => {
        await openSearchInput(provider, treeView);
      },
    ),
    vscode.commands.registerCommand(
      CLEAR_SEARCH_COMMAND,
      async (): Promise<void> => {
        await provider.setSearchQuery('');
        treeView.description = undefined;
      },
    ),
    vscode.commands.registerCommand(
      OPEN_MIGRATION_COMMAND,
      async (item?: MigrationTreeItem): Promise<void> => {
        await openMigrationDiff(item, virtualDocumentProvider);
      },
    ),
    vscode.commands.registerCommand(
      OPEN_SOURCE_MIGRATION_COMMAND,
      async (item?: MigrationTreeItem): Promise<void> => {
        await openSourceMigration(item, virtualDocumentProvider);
      },
    ),
    vscode.commands.registerCommand(
      OPEN_PREVIOUS_MIGRATION_COMMAND,
      async (item?: MigrationTreeItem): Promise<void> => {
        await openPreviousMigration(item, virtualDocumentProvider);
      },
    ),
    vscode.commands.registerCommand(
      OPEN_RELATED_QUERIES_COMMAND,
      async (item?: MigrationTreeItem): Promise<void> => {
        await openRelatedQueries(item, virtualDocumentProvider);
      },
    ),
  );

  void provider.refresh();
}

async function openSourceMigration(
  item: MigrationTreeItem | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!item) {
    return;
  }

  try {
    await openRpcVersion(item.model.latestVersion, contentProvider);
  } catch {
    void vscode.window.showErrorMessage('Failed to open the latest migration file for the selected RPC.');
  }
}

async function openPreviousMigration(
  item: MigrationTreeItem | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!item?.model.comparisonVersion) {
    return;
  }

  try {
    await openRpcVersion(item.model.comparisonVersion, contentProvider);
  } catch {
    void vscode.window.showErrorMessage('Failed to open the previous migration file for the selected RPC.');
  }
}

async function openRelatedQueries(
  item: MigrationTreeItem | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!item) {
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(
      contentProvider.createDocumentUri(
        `${item.model.label} related.sql`,
        getLatestMigrationRelatedQueriesContent(item.model.latestVersion),
      ),
    );

    await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: false,
    });
  } catch {
    void vscode.window.showErrorMessage('Failed to open related queries for the selected RPC.');
  }
}

export function deactivate(): void { }

async function openMigrationDiff(
  item: MigrationTreeItem | undefined,
  contentProvider: RpcDiffContentProvider,
): Promise<void> {
  if (!item) {
    return;
  }

  try {
    const latestVersion = item.model.latestVersion;
    const previousVersion = item.model.comparisonVersion;

    if (!previousVersion) {
      await openSourceMigration(item, contentProvider);
      return;
    }

    const latestContent = formatRpcVersion(latestVersion);
    const leftUri = contentProvider.createDocumentUri(
      `${item.model.label} previous.sql`,
      formatRpcVersion(previousVersion),
    );
    const rightUri = contentProvider.createDocumentUri(
      `${item.model.label} latest.sql`,
      latestContent,
    );

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      buildDiffTitle(item.model.label, previousVersion, latestVersion),
      {
        preview: true,
        preserveFocus: false,
      },
    );
  } catch {
    void vscode.window.showErrorMessage('Failed to open the RPC diff view.');
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

class RpcFileDecorationProvider implements vscode.FileDecorationProvider {
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> | undefined;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== RPC_TREE_ITEM_SCHEME) {
      return undefined;
    }

    const changeState = new URLSearchParams(uri.query).get('state');

    if (changeState === 'new') {
      return new vscode.FileDecoration(
        undefined,
        'New RPC in the current branch',
        new vscode.ThemeColor('charts.green'),
      );
    }

    if (changeState === 'updated') {
      return new vscode.FileDecoration(
        undefined,
        'Updated RPC in the current branch',
        new vscode.ThemeColor('charts.yellow'),
      );
    }

    return undefined;
  }
}

function formatRpcVersion(version: RpcVersionModel): string {
  const headerLines = [
    `-- RPC: ${version.qualifiedName}`,
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

async function openSearchInput(
  provider: SupabaseMigrationsProvider,
  treeView: vscode.TreeView<unknown>,
): Promise<void> {
  const inputBox = vscode.window.createInputBox();

  inputBox.placeholder = 'Search RPC names, migration paths, or SQL text';
  inputBox.prompt = 'Type to filter the Supabase RPC list';
  inputBox.value = provider.getSearchQuery();

  const syncSearch = async (value: string) => {
    await provider.setSearchQuery(value);
    treeView.description = value.trim() ? `Search: ${value.trim()}` : undefined;
  };

  inputBox.onDidChangeValue((value) => {
    void syncSearch(value);
  });
  inputBox.onDidAccept(() => {
    inputBox.hide();
  });
  inputBox.onDidHide(() => {
    inputBox.dispose();
  });

  inputBox.show();
}