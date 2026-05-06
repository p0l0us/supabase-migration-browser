import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { parseGitPathList } from './git-status';
import {
  buildMigrationModels,
  consumeObjectEntryCacheDirty,
  filterMigrationModels,
  getEmptyState,
  getFilteredSearchEmptyState,
  getPersistedObjectEntryCache,
  restorePersistedObjectEntryCache,
  type EmptyStateModel,
  type MigrationKindFilter,
  type MigrationFileDescriptor,
  type MigrationModel,
} from './migrations';

const execFileAsync = promisify(execFile);
const MAX_BASE_MIGRATION_CACHE_SIZE = 20;
const PERSISTENT_CACHE_FILE_NAME = 'supabase-migration-browser-cache.json';
const PERSISTENT_CACHE_VERSION = 1;
const TARGET_BRANCH_GIT_READ_CONCURRENCY = 6;
const WORKSPACE_FILE_READ_CONCURRENCY = 24;

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

export type ProviderControlsState = Pick<
  ProviderState,
  'comparisonBranches' | 'detectGitChanges' | 'selectedComparisonBranch'
> & {
  kindFilter: MigrationKindFilter;
  searchQuery: string;
  showOnlyChanged: boolean;
};

export type ProviderLoadingStatus = {
  detail: string;
  progressPercent?: number;
};

export class SupabaseMigrationsProvider
  implements vscode.Disposable {
  private readonly baseMigrationFilesCache = new Map<string, MigrationFileDescriptor[]>();
  private readonly controlsEmitter = new vscode.EventEmitter<ProviderControlsState>();
  private readonly loadingStatusEmitter = new vscode.EventEmitter<ProviderLoadingStatus>();
  private readonly loadedPersistentCacheWorkspaceUris = new Set<string>();
  private readonly stateEmitter = new vscode.EventEmitter<ProviderState>();
  private readonly watcher: vscode.FileSystemWatcher;
  private cachedState?: ProviderState;
  private comparisonBranch?: string;
  private currentBranch?: string | null;
  private detectGitChanges = false;
  private kindFilter: MigrationKindFilter = 'all';
  private persistentCacheDirty = false;
  private searchQuery = '';
  private showOnlyChanged = false;
  private stateRequestId = 0;

  readonly onDidChangeControls = this.controlsEmitter.event;
  readonly onDidChangeLoadingStatus = this.loadingStatusEmitter.event;
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
    this.baseMigrationFilesCache.clear();
    this.cachedState = undefined;
    this.controlsEmitter.dispose();
    this.loadingStatusEmitter.dispose();
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
    const state = await this.readState(requestId, emit);

    if (requestId !== this.stateRequestId) {
      return this.cachedState ?? state;
    }

    this.cachedState = state;

    if (emit) {
      this.stateEmitter.fire(state);
    }

    return state;
  }

  private async readState(
    requestId: number,
    emitControls: boolean,
  ): Promise<ProviderState> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    this.emitLoadingStatus(requestId, emitControls, 'Loading persisted cache');
    await this.loadPersistentCaches(workspaceFolders);

    const files: MigrationFileDescriptor[] = [];
    const baseFiles: MigrationFileDescriptor[] = [];
    this.emitLoadingStatus(requestId, emitControls, 'Checking current Git branch');
    const currentBranch = this.detectGitChanges && workspaceFolders[0]
      ? await getCurrentBranch(workspaceFolders[0])
      : null;

    if (this.currentBranch !== undefined && this.currentBranch !== currentBranch) {
      this.comparisonBranch = undefined;
    }

    this.currentBranch = currentBranch;

    this.emitLoadingStatus(requestId, emitControls, this.detectGitChanges
      ? 'Listing origin branches from local Git refs'
      : 'Git detection disabled');
    const comparisonBranches = this.detectGitChanges && workspaceFolders[0]
      ? await getOriginBranches(workspaceFolders[0])
      : [];
    this.emitLoadingStatus(requestId, emitControls, 'Resolving comparison branch');
    const selectedComparisonBranch = this.detectGitChanges
      ? await resolveSelectedComparisonBranch(
        workspaceFolders[0],
        comparisonBranches,
        this.comparisonBranch,
      )
      : null;

    this.comparisonBranch = selectedComparisonBranch ?? undefined;

    if (emitControls && requestId === this.stateRequestId) {
      this.controlsEmitter.fire({
        comparisonBranches,
        detectGitChanges: this.detectGitChanges,
        kindFilter: this.kindFilter,
        searchQuery: this.searchQuery,
        selectedComparisonBranch,
        showOnlyChanged: this.showOnlyChanged,
      });
    }

    let hasMigrationsFolder = false;

    for (const workspaceFolder of workspaceFolders) {
      if (this.detectGitChanges) {
        const workspaceBaseFilesResult = await getBaseMigrationFiles(
          workspaceFolder,
          selectedComparisonBranch,
          this.baseMigrationFilesCache,
          (status) => this.emitLoadingStatus(requestId, emitControls, status.detail, status.progressPercent),
        );
        baseFiles.push(...workspaceBaseFilesResult.files);

        if (!workspaceBaseFilesResult.cacheHit) {
          this.persistentCacheDirty = true;
        }
      }

      const migrationFolderUri = vscode.Uri.joinPath(
        workspaceFolder.uri,
        'supabase',
        'migrations',
      );

      let directoryEntries: [string, vscode.FileType][];

      try {
        this.emitLoadingStatus(requestId, emitControls, `Reading ${workspaceFolder.name} migration directory`);
        directoryEntries = await vscode.workspace.fs.readDirectory(
          migrationFolderUri,
        );
        hasMigrationsFolder = true;
      } catch {
        continue;
      }

      const sqlEntries = directoryEntries.filter(([entryName, fileType]) => (
        fileType === vscode.FileType.File && entryName.toLowerCase().endsWith('.sql')
      ));
      let readFileCount = 0;

      const workspaceMigrationFiles = await mapWithConcurrency(
        sqlEntries,
        WORKSPACE_FILE_READ_CONCURRENCY,
        async ([entryName]) => {
          const fileUri = vscode.Uri.joinPath(migrationFolderUri, entryName);
          const fileContent = await vscode.workspace.fs.readFile(fileUri);
          const workspaceRelativePath = vscode.workspace.asRelativePath(fileUri, false);

          readFileCount += 1;
          this.emitLoadingStatus(
            requestId,
            emitControls,
            `Reading workspace migration ${entryName}`,
            getProgressPercent(readFileCount, sqlEntries.length),
          );

          return {
            content: new TextDecoder().decode(fileContent),
            fileName: entryName,
            uriString: fileUri.toString(),
            workspaceRelativePath,
            workspaceFolderName: workspaceFolder.name,
          } satisfies MigrationFileDescriptor;
        },
      );

      files.push(...workspaceMigrationFiles);
    }

    this.emitLoadingStatus(requestId, emitControls, 'Parsing RPCs and views from migrations');
    const items = buildMigrationModels(files, baseFiles, {
      detectChanges: this.detectGitChanges,
    });
    this.emitLoadingStatus(requestId, emitControls, 'Applying search, type, and changed-only filters');
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

    if (consumeObjectEntryCacheDirty() || this.persistentCacheDirty) {
      this.emitLoadingStatus(requestId, emitControls, 'Saving workspace cache');
      await this.savePersistentCaches(workspaceFolders);
    }

    return {
      comparisonBranches,
      detectGitChanges: this.detectGitChanges,
      emptyState,
      includeWorkspaceName: workspaceFolders.length > 1,
      items: filteredItems,
      selectedComparisonBranch,
    };
  }

  private async loadPersistentCaches(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ): Promise<void> {
    for (const workspaceFolder of workspaceFolders) {
      const workspaceUriString = workspaceFolder.uri.toString();

      if (this.loadedPersistentCacheWorkspaceUris.has(workspaceUriString)) {
        continue;
      }

      this.loadedPersistentCacheWorkspaceUris.add(workspaceUriString);

      const cacheFileUri = getPersistentCacheFileUri(workspaceFolder);

      try {
        const cacheFileContent = await vscode.workspace.fs.readFile(cacheFileUri);
        const parsedCache: unknown = JSON.parse(new TextDecoder().decode(cacheFileContent));
        const cache = parsePersistentWorkspaceCache(parsedCache);

        if (!cache) {
          continue;
        }

        restorePersistedObjectEntryCache(cache.objectEntryCache);

        for (const entry of cache.baseMigrationFilesCache) {
          if (entry.key.startsWith(`${workspaceUriString}|`)) {
            this.baseMigrationFilesCache.set(entry.key, entry.files);
          }
        }

        trimBaseMigrationFilesCache(this.baseMigrationFilesCache);
      } catch {
        // Ignore missing or invalid persisted caches; they are only an optimization.
      }
    }
  }

  private async savePersistentCaches(
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ): Promise<void> {
    let saved = false;

    for (const workspaceFolder of workspaceFolders) {
      const workspaceUriString = workspaceFolder.uri.toString();
      const cacheFileUri = getPersistentCacheFileUri(workspaceFolder);
      const cacheDirectoryUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
      const cache: PersistentWorkspaceCache = {
        baseMigrationFilesCache: getPersistedBaseMigrationFilesCache(
          this.baseMigrationFilesCache,
          workspaceUriString,
        ),
        objectEntryCache: getPersistedObjectEntryCache(workspaceUriString),
        savedAt: new Date().toISOString(),
        version: PERSISTENT_CACHE_VERSION,
      };

      try {
        await vscode.workspace.fs.createDirectory(cacheDirectoryUri);
        await vscode.workspace.fs.writeFile(
          cacheFileUri,
          new TextEncoder().encode(JSON.stringify(cache, null, 2)),
        );
        saved = true;
      } catch {
        // Ignore cache persistence failures; in-memory cache still works.
      }
    }

    if (saved) {
      this.persistentCacheDirty = false;
    }
  }

  private emitLoadingStatus(
    requestId: number,
    emit: boolean,
    detail: string,
    progressPercent?: number,
  ): void {
    if (!emit || requestId !== this.stateRequestId) {
      return;
    }

    this.loadingStatusEmitter.fire({
      detail,
      progressPercent,
    });
  }
}

type PersistentWorkspaceCache = {
  baseMigrationFilesCache: PersistedBaseMigrationFilesCacheEntry[];
  objectEntryCache: unknown;
  savedAt: string;
  version: number;
};

type PersistedBaseMigrationFilesCacheEntry = {
  files: MigrationFileDescriptor[];
  key: string;
};

type BaseMigrationFilesResult = {
  cacheHit: boolean;
  files: MigrationFileDescriptor[];
};

async function getBaseMigrationFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  comparisonRef: string | null,
  cache: Map<string, MigrationFileDescriptor[]>,
  onProgress?: (status: ProviderLoadingStatus) => void,
): Promise<BaseMigrationFilesResult> {
  onProgress?.({ detail: `Resolving Git merge-base for ${comparisonRef ?? 'default branch'}` });
  const mergeBase = await resolveMergeBase(workspaceFolder, comparisonRef);

  if (!mergeBase) {
    return {
      cacheHit: true,
      files: [],
    };
  }

  const cacheKey = getBaseMigrationFilesCacheKey(
    workspaceFolder,
    comparisonRef,
    mergeBase,
  );
  const cachedFiles = cache.get(cacheKey);

  if (cachedFiles) {
    onProgress?.({
      detail: `Using cached target-branch migrations for ${comparisonRef ?? mergeBase}`,
      progressPercent: 100,
    });
    return {
      cacheHit: true,
      files: cachedFiles,
    };
  }

  onProgress?.({ detail: `Listing target-branch migrations at ${mergeBase.slice(0, 8)}` });
  const migrationPaths = await getMigrationPathsAtRef(workspaceFolder, mergeBase);
  let readMigrationCount = 0;
  const migrationFiles = await mapWithConcurrency<string, MigrationFileDescriptor | null>(
    migrationPaths,
    TARGET_BRANCH_GIT_READ_CONCURRENCY,
    async (migrationPath) => {
      const content = await getFileContentAtRef(
        workspaceFolder,
        mergeBase,
        migrationPath,
      );

      readMigrationCount += 1;
      onProgress?.({
        detail: `Reading target migration ${path.posix.basename(migrationPath)} from Git`,
        progressPercent: getProgressPercent(readMigrationCount, migrationPaths.length),
      });

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
    },
  );

  const files = migrationFiles.filter(
    (migrationFile): migrationFile is MigrationFileDescriptor => migrationFile !== null,
  );

  cache.set(cacheKey, files);
  trimBaseMigrationFilesCache(cache);

  return {
    cacheHit: false,
    files,
  };
}

async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }

  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;

      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from(
    { length: normalizedConcurrency },
    () => worker(),
  ));

  return results;
}

function getProgressPercent(
  completedCount: number,
  totalCount: number,
): number | undefined {
  if (totalCount <= 0) {
    return undefined;
  }

  return Math.min(100, Math.max(0, Math.round((completedCount / totalCount) * 100)));
}

function getPersistentCacheFileUri(
  workspaceFolder: vscode.WorkspaceFolder,
): vscode.Uri {
  return vscode.Uri.joinPath(
    workspaceFolder.uri,
    '.vscode',
    PERSISTENT_CACHE_FILE_NAME,
  );
}

function getPersistedBaseMigrationFilesCache(
  cache: Map<string, MigrationFileDescriptor[]>,
  workspaceUriString: string,
): PersistedBaseMigrationFilesCacheEntry[] {
  return [...cache.entries()]
    .filter(([key]) => key.startsWith(`${workspaceUriString}|`))
    .map(([key, files]) => ({
      files,
      key,
    }));
}

function parsePersistentWorkspaceCache(
  value: unknown,
): PersistentWorkspaceCache | null {
  if (!isRecord(value)) {
    return null;
  }

  const version = value.version;
  const savedAt = readStringProperty(value, 'savedAt');
  const baseMigrationFilesCache = parsePersistedBaseMigrationFilesCache(
    value.baseMigrationFilesCache,
  );
  const objectEntryCache = value.objectEntryCache;

  if (
    version !== PERSISTENT_CACHE_VERSION ||
    savedAt === undefined ||
    baseMigrationFilesCache === null ||
    objectEntryCache === undefined
  ) {
    return null;
  }

  return {
    baseMigrationFilesCache,
    objectEntryCache,
    savedAt,
    version,
  };
}

function parsePersistedBaseMigrationFilesCache(
  value: unknown,
): PersistedBaseMigrationFilesCacheEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries: PersistedBaseMigrationFilesCacheEntry[] = [];

  for (const entryValue of value) {
    const entry = parsePersistedBaseMigrationFilesCacheEntry(entryValue);

    if (!entry) {
      return null;
    }

    entries.push(entry);
  }

  return entries;
}

function parsePersistedBaseMigrationFilesCacheEntry(
  value: unknown,
): PersistedBaseMigrationFilesCacheEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = readStringProperty(value, 'key');
  const filesValue = value.files;

  if (!key || !Array.isArray(filesValue)) {
    return null;
  }

  const files: MigrationFileDescriptor[] = [];

  for (const fileValue of filesValue) {
    const file = parseMigrationFileDescriptor(fileValue);

    if (!file) {
      return null;
    }

    files.push(file);
  }

  return { files, key };
}

function parseMigrationFileDescriptor(
  value: unknown,
): MigrationFileDescriptor | null {
  if (!isRecord(value)) {
    return null;
  }

  const content = readStringProperty(value, 'content');
  const fileName = readStringProperty(value, 'fileName');
  const uriString = readStringProperty(value, 'uriString');
  const workspaceRelativePath = readStringProperty(value, 'workspaceRelativePath');
  const workspaceFolderName = readOptionalStringProperty(value, 'workspaceFolderName');
  const sourceKind = readOptionalSourceKindProperty(value, 'sourceKind');

  if (
    content === undefined ||
    fileName === undefined ||
    uriString === undefined ||
    workspaceRelativePath === undefined ||
    workspaceFolderName === null ||
    sourceKind === null
  ) {
    return null;
  }

  return {
    content,
    fileName,
    sourceKind,
    uriString,
    workspaceFolderName,
    workspaceRelativePath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringProperty(
  record: Record<string, unknown>,
  propertyName: string,
): string | undefined {
  const value = record[propertyName];

  return typeof value === 'string'
    ? value
    : undefined;
}

function readOptionalStringProperty(
  record: Record<string, unknown>,
  propertyName: string,
): string | null | undefined {
  const value = record[propertyName];

  if (value === undefined) {
    return undefined;
  }

  return typeof value === 'string'
    ? value
    : null;
}

function readOptionalSourceKindProperty(
  record: Record<string, unknown>,
  propertyName: string,
): 'workspace' | 'history' | null | undefined {
  const value = record[propertyName];

  if (value === undefined) {
    return undefined;
  }

  if (value === 'workspace' || value === 'history') {
    return value;
  }

  return null;
}

function getBaseMigrationFilesCacheKey(
  workspaceFolder: vscode.WorkspaceFolder,
  comparisonRef: string | null,
  mergeBase: string,
): string {
  return [
    workspaceFolder.uri.toString(),
    comparisonRef ?? '',
    mergeBase,
  ].join('|');
}

function trimBaseMigrationFilesCache(
  cache: Map<string, MigrationFileDescriptor[]>,
): void {
  while (cache.size > MAX_BASE_MIGRATION_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value as string | undefined;

    if (!oldestKey) {
      return;
    }

    cache.delete(oldestKey);
  }
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