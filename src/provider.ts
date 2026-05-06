import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { parseGitPathList } from './git-status';
import {
  buildMigrationModels,
  filterMigrationModels,
  getEmptyState,
  getFilteredSearchEmptyState,
  type EmptyStateModel,
  type MigrationKindFilter,
  type MigrationFileDescriptor,
  type MigrationModel,
} from './migrations';

const execFileAsync = promisify(execFile);
export type ComparisonBranchModel = {
  isDefault: boolean;
  label: string;
  ref: string;
};

export type ProviderState = {
  comparisonBranches: ComparisonBranchModel[];
  detectGitChanges: boolean;
  emptyState: EmptyStateModel | null;
  includeWorkspaceName: boolean;
  items: MigrationModel[];
  selectedComparisonBranch: string | null;
};

export class SupabaseMigrationsProvider
  implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<ProviderState>();
  private readonly watcher: vscode.FileSystemWatcher;
  private cachedState?: ProviderState;
  private comparisonBranch?: string;
  private currentBranch?: string | null;
  private detectGitChanges = false;
  private kindFilter: MigrationKindFilter = 'all';
  private searchQuery = '';
  private showOnlyChanged = false;
  private stateRequestId = 0;

  readonly onDidChangeState = this.stateEmitter.event;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/supabase/migrations/*.sql',
    );

    const refresh = () => {
      void this.refresh();
    };

    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
    this.watcher.onDidChange(refresh);
  }

  dispose(): void {
    this.cachedState = undefined;
    this.watcher.dispose();
    this.stateEmitter.dispose();
  }

  async refresh(): Promise<void> {
    await this.loadState(true, true);
  }

  async refreshForCurrentBranchChange(): Promise<void> {
    if (!this.detectGitChanges) {
      return;
    }

    this.comparisonBranch = undefined;
    await this.refresh();
  }

  async setSearchQuery(searchQuery: string): Promise<void> {
    this.searchQuery = searchQuery;
    await this.loadState(true, true);
  }

  async setKindFilter(kindFilter: MigrationKindFilter): Promise<void> {
    this.kindFilter = kindFilter;
    await this.loadState(true, true);
  }

  async setComparisonBranch(comparisonBranch: string): Promise<void> {
    this.comparisonBranch = comparisonBranch;
    await this.loadState(true, true);
  }

  async setDetectGitChanges(detectGitChanges: boolean): Promise<void> {
    this.detectGitChanges = detectGitChanges;

    if (!detectGitChanges) {
      this.comparisonBranch = undefined;
      this.currentBranch = undefined;
    }

    await this.loadState(true, true);
  }

  async setShowOnlyChanged(showOnlyChanged: boolean): Promise<void> {
    this.showOnlyChanged = showOnlyChanged;
    await this.loadState(true, true);
  }

  getKindFilter(): MigrationKindFilter {
    return this.kindFilter;
  }

  getDetectGitChanges(): boolean {
    return this.detectGitChanges;
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  getShowOnlyChanged(): boolean {
    return this.showOnlyChanged;
  }

  async getState(force = false): Promise<ProviderState> {
    return this.loadState(force, false);
  }

  private async loadState(force: boolean, emit: boolean): Promise<ProviderState> {
    if (!force && this.cachedState) {
      return this.cachedState;
    }

    const requestId = ++this.stateRequestId;
    const state = await this.readState();

    if (requestId !== this.stateRequestId) {
      return this.cachedState ?? state;
    }

    this.cachedState = state;

    if (emit) {
      this.stateEmitter.fire(state);
    }

    return state;
  }

  private async readState(): Promise<ProviderState> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const files: MigrationFileDescriptor[] = [];
    const baseFiles: MigrationFileDescriptor[] = [];
    const currentBranch = this.detectGitChanges && workspaceFolders[0]
      ? await getCurrentBranch(workspaceFolders[0])
      : null;

    if (this.currentBranch !== undefined && this.currentBranch !== currentBranch) {
      this.comparisonBranch = undefined;
    }

    this.currentBranch = currentBranch;

    const comparisonBranches = this.detectGitChanges && workspaceFolders[0]
      ? await getOriginBranches(workspaceFolders[0])
      : [];
    const selectedComparisonBranch = this.detectGitChanges
      ? await resolveSelectedComparisonBranch(
        workspaceFolders[0],
        comparisonBranches,
        this.comparisonBranch,
      )
      : null;

    this.comparisonBranch = selectedComparisonBranch ?? undefined;

    let hasMigrationsFolder = false;

    for (const workspaceFolder of workspaceFolders) {
      if (this.detectGitChanges) {
        const workspaceBaseFiles = await getBaseMigrationFiles(
          workspaceFolder,
          selectedComparisonBranch,
        );
        baseFiles.push(...workspaceBaseFiles);
      }

      const migrationFolderUri = vscode.Uri.joinPath(
        workspaceFolder.uri,
        'supabase',
        'migrations',
      );

      let directoryEntries: [string, vscode.FileType][];

      try {
        directoryEntries = await vscode.workspace.fs.readDirectory(
          migrationFolderUri,
        );
        hasMigrationsFolder = true;
      } catch {
        continue;
      }

      for (const [entryName, fileType] of directoryEntries) {
        if (
          fileType !== vscode.FileType.File ||
          !entryName.toLowerCase().endsWith('.sql')
        ) {
          continue;
        }

        const fileUri = vscode.Uri.joinPath(migrationFolderUri, entryName);
        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        const workspaceRelativePath = vscode.workspace.asRelativePath(fileUri, false);

        files.push({
          content: new TextDecoder().decode(fileContent),
          fileName: entryName,
          uriString: fileUri.toString(),
          workspaceRelativePath,
          workspaceFolderName: workspaceFolder.name,
        });
      }
    }

    const items = buildMigrationModels(files, baseFiles, {
      detectChanges: this.detectGitChanges,
    });
    const filteredItems = filterMigrationModels(
      items,
      this.searchQuery,
      this.kindFilter,
      this.detectGitChanges && this.showOnlyChanged,
    );

    const emptyState = this.searchQuery.trim()
      ? filteredItems.length === 0
        ? getFilteredSearchEmptyState(
          this.searchQuery.trim(),
          this.kindFilter,
          this.detectGitChanges && this.showOnlyChanged,
        )
        : null
      : getEmptyState({
        hasMigrationsFolder,
        hasSqlFiles: items.length > 0,
        hasFilteredItems: filteredItems.length > 0,
        kindFilter: this.kindFilter,
        showOnlyChanged: this.detectGitChanges && this.showOnlyChanged,
      });

    return {
      comparisonBranches,
      detectGitChanges: this.detectGitChanges,
      emptyState,
      includeWorkspaceName: workspaceFolders.length > 1,
      items: filteredItems,
      selectedComparisonBranch,
    };
  }
}

async function getBaseMigrationFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  comparisonRef: string | null,
): Promise<MigrationFileDescriptor[]> {
  const mergeBase = await resolveMergeBase(workspaceFolder, comparisonRef);

  if (!mergeBase) {
    return [];
  }

  const migrationPaths = await getMigrationPathsAtRef(workspaceFolder, mergeBase);
  const migrationFiles: Array<MigrationFileDescriptor | null> = await Promise.all(
    migrationPaths.map(async (migrationPath) => {
      const content = await getFileContentAtRef(
        workspaceFolder,
        mergeBase,
        migrationPath,
      );

      if (content === null) {
        return null;
      }

      return {
        content,
        fileName: path.posix.basename(migrationPath),
        sourceKind: 'history',
        uriString: vscode.Uri.joinPath(workspaceFolder.uri, migrationPath).toString(),
        workspaceRelativePath: migrationPath,
        workspaceFolderName: workspaceFolder.name,
      } satisfies MigrationFileDescriptor;
    }),
  );

  return migrationFiles.filter(
    (migrationFile): migrationFile is MigrationFileDescriptor => migrationFile !== null,
  );
}

async function resolveMergeBase(
  workspaceFolder: vscode.WorkspaceFolder,
  comparisonRef: string | null,
): Promise<string | null> {
  const comparisonRefs = comparisonRef
    ? [comparisonRef]
    : await getComparisonRefs(workspaceFolder);

  for (const comparisonRef of comparisonRefs) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['merge-base', 'HEAD', comparisonRef],
        {
          cwd: workspaceFolder.uri.fsPath,
        },
      );

      const mergeBase = stdout.trim();

      if (mergeBase) {
        return mergeBase;
      }
    } catch {
      continue;
    }
  }

  if (comparisonRef) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--verify', '--quiet', comparisonRef],
        {
          cwd: workspaceFolder.uri.fsPath,
        },
      );

      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceFolder.uri.fsPath,
    });

    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getComparisonRefs(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string[]> {
  const refs = new Set<string>();

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );

    const remoteHead = stdout.trim();

    if (remoteHead) {
      refs.add(remoteHead);
    }
  } catch {
    // Ignore missing remote HEAD metadata.
  }

  for (const candidateRef of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--verify', '--quiet', candidateRef],
        {
          cwd: workspaceFolder.uri.fsPath,
        },
      );

      if (stdout.trim()) {
        refs.add(candidateRef);
      }
    } catch {
      continue;
    }
  }

  return [...refs];
}

async function getOriginBranches(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<ComparisonBranchModel[]> {
  const defaultBranch = await resolveDefaultOriginBranch(workspaceFolder);

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );

    return parseGitPathList(stdout)
      .filter((ref) => ref !== 'origin/HEAD')
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
      .map((ref) => ({
        isDefault: ref === defaultBranch,
        label: ref.replace(/^origin\//, ''),
        ref,
      }));
  } catch {
    return [];
  }
}

async function resolveSelectedComparisonBranch(
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  comparisonBranches: ComparisonBranchModel[],
  selectedComparisonBranch: string | undefined,
): Promise<string | null> {
  if (comparisonBranches.length === 0) {
    return null;
  }

  if (
    selectedComparisonBranch &&
    comparisonBranches.some((branch) => branch.ref === selectedComparisonBranch)
  ) {
    return selectedComparisonBranch;
  }

  const defaultBranch = workspaceFolder
    ? await resolveDefaultOriginBranch(workspaceFolder)
    : null;

  return comparisonBranches.find((branch) => branch.ref === defaultBranch)?.ref ??
    comparisonBranches[0]?.ref ??
    null;
}

async function resolveDefaultOriginBranch(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string | null> {
  const currentBranch = await getCurrentBranch(workspaceFolder);
  const configuredBaseBranch = currentBranch
    ? await getConfiguredBaseBranch(workspaceFolder, currentBranch)
    : null;

  if (configuredBaseBranch) {
    return configuredBaseBranch;
  }

  const remoteHead = await getRemoteHeadBranch(workspaceFolder);

  if (remoteHead) {
    return remoteHead;
  }

  for (const candidateRef of ['origin/develop', 'origin/main', 'origin/master']) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--verify', '--quiet', candidateRef],
        {
          cwd: workspaceFolder.uri.fsPath,
        },
      );

      if (stdout.trim()) {
        return candidateRef;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function getCurrentBranch(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['branch', '--show-current'],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );

    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getConfiguredBaseBranch(
  workspaceFolder: vscode.WorkspaceFolder,
  currentBranch: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', `branch.${currentBranch}.gh-merge-base`],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );
    const configuredBranch = stdout.trim();

    if (configuredBranch) {
      return configuredBranch.startsWith('origin/')
        ? configuredBranch
        : `origin/${configuredBranch}`;
    }
  } catch {
    // Ignore missing GitHub merge-base metadata.
  }

  return null;
}

async function getRemoteHeadBranch(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );

    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getMigrationPathsAtRef(
  workspaceFolder: vscode.WorkspaceFolder,
  ref: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-tree', '-r', '--name-only', ref, '--', 'supabase/migrations'],
      {
        cwd: workspaceFolder.uri.fsPath,
      },
    );

    return parseGitPathList(stdout).filter((migrationPath) =>
      migrationPath.toLowerCase().endsWith('.sql'),
    );
  } catch {
    return [];
  }
}

async function getFileContentAtRef(
  workspaceFolder: vscode.WorkspaceFolder,
  ref: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${ref}:${relativePath}`],
      {
        cwd: workspaceFolder.uri.fsPath,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return stdout;
  } catch {
    return null;
  }
}