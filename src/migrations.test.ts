import { describe, expect, it } from 'vitest';

import {
  buildMigrationModels,
  canOpenRpcDiff,
  getPersistedObjectEntryCache,
  extractRpcNames,
  extractViewNames,
  filterMigrationModels,
  getFilteredSearchEmptyState,
  getMigrationRelatedQueriesContent,
  getEmptyState,
  getSearchEmptyState,
  hasMigrationRelatedQueriesContent,
  hasComparisonMigration,
  normalizeSqlForDiff,
  parseMigrationFileName,
  restorePersistedObjectEntryCache,
  type MigrationFileDescriptor,
} from './migrations';

function createMigrationFileDescriptor(
  fileName: string,
  content = '',
  workspaceRelativePath = `supabase/migrations/${fileName}`,
): MigrationFileDescriptor {
  return {
    content,
    fileName,
    uriString: `file:///workspace/${workspaceRelativePath}`,
    workspaceRelativePath,
  };
}

describe('parseMigrationFileName', () => {
  it('extracts a timestamp from a timestamped migration filename', () => {
    expect(
      parseMigrationFileName(
        '20260409184202_split_dashboard_mining_summary_hashrate_arrays.sql',
      ),
    ).toEqual({
      fileName:
        '20260409184202_split_dashboard_mining_summary_hashrate_arrays.sql',
      timestamp: '20260409184202',
    });
  });

  it('falls back to a null timestamp for non-timestamped sql files', () => {
    expect(parseMigrationFileName('manual_cleanup_patch.sql')).toEqual({
      fileName: 'manual_cleanup_patch.sql',
      timestamp: null,
    });
  });
});

describe('extractRpcNames', () => {
  it('extracts exact rpc names without inserting spaces', () => {
    const content = `
      create or replace function public.get_user_dashboard_mining_summary(p_user_id uuid)
      returns table (worker_status_online bigint)
      language sql
      as $$ select 1; $$;

      create function public.add_wallet_manual_movement_merge_actions()
      returns void
      language sql
      as $$ select; $$;
    `;

    expect(extractRpcNames(content)).toEqual([
      'public.get_user_dashboard_mining_summary',
      'public.add_wallet_manual_movement_merge_actions',
    ]);
  });

  it('ignores commented out function declarations', () => {
    const content = `
      -- create or replace function public.commented_out_rpc()
      -- returns void language sql as $$ select; $$;

      /*
        create or replace function public.blocked_out_rpc()
        returns void language sql as $$ select; $$;
      */

      create or replace function public.real_rpc()
      returns void
      language sql
      as $$ select; $$;
    `;

    expect(extractRpcNames(content)).toEqual(['public.real_rpc']);
  });

  it('extracts quoted rpc names and preserves the exact qualified name', () => {
    const content = `
      create or replace function public."MixedCaseRpc"()
      returns void
      language sql
      as $$ select; $$;
    `;

    expect(extractRpcNames(content)).toEqual(['public."MixedCaseRpc"']);
  });
});

describe('extractViewNames', () => {
  it('extracts regular and quoted view names', () => {
    const content = `
      create or replace view public.active_users as
      select id from public.users where active = true;

      create view analytics."DailyTotals" (day, total) as
      select now()::date, count(*) from public.orders;
    `;

    expect(extractViewNames(content)).toEqual([
      'public.active_users',
      'analytics."DailyTotals"',
    ]);
  });

  it('ignores commented out view declarations', () => {
    const content = `
      -- create or replace view public.commented_view as select 1;

      /* create or replace view public.blocked_view as select 1; */

      create or replace view public.real_view as select 1;
    `;

    expect(extractViewNames(content)).toEqual(['public.real_view']);
  });
});

describe('buildMigrationModels', () => {
  it('keeps each rpc only once using the latest migration timestamp', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260408120000_add_user_roles.sql',
        `create or replace function public.same_rpc() returns void language sql as $$ select; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260409120000_fix_wallet_totals.sql',
        `create or replace function public.same_rpc() returns void language sql as $$ select; $$;
         create or replace function public.latest_rpc() returns void language sql as $$ select; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260407120000_seed_more_data.sql',
        `create or replace function public.older_rpc() returns void language sql as $$ select; $$;`,
      ),
    ]);

    expect(models.map((model) => [model.label, model.description, model.fileName])).toEqual([
      ['public.latest_rpc', '2026-04-09 12:00:00', '20260409120000_fix_wallet_totals.sql'],
      ['public.older_rpc', '2026-04-07 12:00:00', '20260407120000_seed_more_data.sql'],
      ['public.same_rpc', '2026-04-09 12:00:00', '20260409120000_fix_wallet_totals.sql'],
    ]);

    expect(models.find((model) => model.label === 'public.same_rpc')?.previousVersion)
      .toMatchObject({
        fileName: '20260408120000_add_user_roles.sql',
        timestamp: '20260408120000',
      });
  });

  it('places rpc entries from non-timestamped files after timestamped migrations', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        'manual_cleanup_patch.sql',
        `create or replace function public.manual_rpc() returns void language sql as $$ select; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260409120000_fix_wallet_totals.sql',
        `create or replace function public.new_rpc() returns void language sql as $$ select; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260408120000_add_user_roles.sql',
        `create or replace function public.old_rpc() returns void language sql as $$ select; $$;`,
      ),
    ]);

    expect(models.map((model) => model.label)).toEqual([
      'public.manual_rpc',
      'public.new_rpc',
      'public.old_rpc',
    ]);
  });

  it('captures the latest and previous sql definitions for diffing', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260408120000_update_rpc.sql',
        `create or replace function public.diffable_rpc()
returns void
language sql
as $$
begin
  perform 1;
end;
$$;`,
      ),
      createMigrationFileDescriptor(
        '20260409120000_update_rpc_again.sql',
        `create or replace function public.diffable_rpc()
returns void
language sql
as $$
begin
  perform 2;
end;
$$;`,
      ),
    ]);

    expect(models[0]?.latestVersion.sqlDefinition).toContain('perform 2;');
    expect(models[0]?.previousVersion?.sqlDefinition).toContain('perform 1;');
  });

  it('re-parses cached migration descriptors when file content changes', () => {
    const workspaceRelativePath = 'supabase/migrations/20260409120000_cached_rpc.sql';
    const initialModels = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_cached_rpc.sql',
        `create or replace function public.cached_rpc() returns int language sql as $$ select 1; $$;`,
        workspaceRelativePath,
      ),
    ]);
    const updatedModels = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_cached_rpc.sql',
        `create or replace function public.cached_rpc() returns int language sql as $$ select 2; $$;`,
        workspaceRelativePath,
      ),
    ]);

    expect(initialModels[0]?.latestVersion.sqlDefinition).toContain('select 1;');
    expect(updatedModels[0]?.latestVersion.sqlDefinition).toContain('select 2;');
  });

  it('exports and restores persisted object-entry cache snapshots', () => {
    const workspaceUriString = 'file:///workspace';

    buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_persisted_rpc.sql',
        `create or replace function public.persisted_rpc() returns int language sql as $$ select 1; $$;`,
      ),
    ]);

    const persistedCache = getPersistedObjectEntryCache(workspaceUriString);
    const persistedRpcEntry = persistedCache.entries.find((entry) =>
      entry.entries.some((objectEntry) => objectEntry.qualifiedName === 'public.persisted_rpc'),
    );

    expect(persistedRpcEntry?.key).toContain(workspaceUriString);
    expect(persistedRpcEntry?.entries[0]?.qualifiedName).toBe('public.persisted_rpc');
    expect(restorePersistedObjectEntryCache(persistedCache)).toBe(true);
  });

  it('rejects invalid persisted object-entry cache snapshots', () => {
    expect(restorePersistedObjectEntryCache({ entries: [{ key: 'invalid' }] })).toBe(false);
  });

  it('keeps all object versions ordered newest first', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260407120000_create_versioned_rpc.sql',
        `create or replace function public.versioned_rpc() returns int language sql as $$ select 1; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260409120000_update_versioned_rpc.sql',
        `create or replace function public.versioned_rpc() returns int language sql as $$ select 3; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260408120000_revise_versioned_rpc.sql',
        `create or replace function public.versioned_rpc() returns int language sql as $$ select 2; $$;`,
      ),
    ]);

    expect(models[0]?.allVersions.map((version) => version.fileName)).toEqual([
      '20260409120000_update_versioned_rpc.sql',
      '20260408120000_revise_versioned_rpc.sql',
      '20260407120000_create_versioned_rpc.sql',
    ]);
  });

  it('builds view models from create view statements', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260408120000_create_dashboard_view.sql',
        `create or replace view public.dashboard_summary as select 1 as total;`,
      ),
      createMigrationFileDescriptor(
        '20260409120000_update_dashboard_view.sql',
        `create or replace view public.dashboard_summary as select 2 as total;`,
      ),
    ]);

    expect(models[0]).toMatchObject({
      kind: 'view',
      label: 'public.dashboard_summary',
      fileName: '20260409120000_update_dashboard_view.sql',
    });
    expect(models[0]?.latestVersion.kind).toBe('view');
    expect(models[0]?.latestVersion.sqlDefinition).toContain('select 2 as total');
    expect(models[0]?.previousVersion?.sqlDefinition).toContain('select 1 as total');
  });

  it('keeps rpc and view entries separate when names overlap', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_create_overlapping_objects.sql',
        `create or replace function public.shared_name() returns int language sql as $$ select 1; $$;
         create or replace view public.shared_name as select 1 as id;`,
      ),
    ]);

    expect(models.map((model) => [model.kind, model.label])).toEqual([
      ['rpc', 'public.shared_name'],
      ['view', 'public.shared_name'],
    ]);
  });

  it('marks rpc entries as new when they do not exist at the branch base', () => {
    const file = createMigrationFileDescriptor(
      '20260409120000_add_new_rpc.sql',
      `create or replace function public.new_rpc() returns void language sql as $$ select; $$;`,
    );

    const models = buildMigrationModels([file], []);

    expect(models[0]?.changeState).toBe('new');
  });

  it('does not mark objects as new or updated when git change detection is disabled', () => {
    const models = buildMigrationModels(
      [
        createMigrationFileDescriptor(
          '20260409120000_add_rpc.sql',
          `create or replace function public.local_rpc() returns void language sql as $$ select 1; $$;`,
        ),
        createMigrationFileDescriptor(
          '20260410120000_update_rpc.sql',
          `create or replace function public.local_rpc() returns void language sql as $$ select 2; $$;`,
        ),
      ],
      [],
      { detectChanges: false },
    );

    expect(models[0]?.changeState).toBeNull();
    expect(models[0]?.comparisonVersion).toMatchObject({
      fileName: '20260409120000_add_rpc.sql',
    });
    expect(canOpenRpcDiff(models[0]!)).toBe(true);
  });

  it('marks rpc entries as updated when their latest sql differs from the branch base', () => {
    const latestFile = createMigrationFileDescriptor(
      '20260409120000_update_rpc.sql',
      `create or replace function public.updated_rpc() returns void language sql as $$ select 2; $$;`,
    );
    const baseFile = createMigrationFileDescriptor(
      '20260408120000_update_rpc.sql',
      `create or replace function public.updated_rpc() returns void language sql as $$ select 1; $$;`,
    );

    const models = buildMigrationModels([latestFile], [baseFile]);

    expect(models[0]?.changeState).toBe('updated');
    expect(models[0]?.comparisonVersion).toMatchObject({
      fileName: '20260408120000_update_rpc.sql',
      sourceKind: 'workspace',
    });
  });

  it('keeps rpc entries unchanged when their latest sql matches the branch base', () => {
    const currentFile = createMigrationFileDescriptor(
      '20260409120000_refresh_rpc.sql',
      `create or replace function public.stable_rpc() returns void language sql as $$ select 1; $$;`,
    );
    const baseFile = createMigrationFileDescriptor(
      '20260401120000_refresh_rpc.sql',
      `create or replace function public.stable_rpc() returns void language sql as $$ select 1; $$;`,
    );

    const models = buildMigrationModels([currentFile], [baseFile]);

    expect(models[0]?.changeState).toBeNull();
  });

  it('keeps branch-created rpc entries marked as new even when the branch already revised them', () => {
    const latestFile = createMigrationFileDescriptor(
      '20260410120000_revise_branch_rpc.sql',
      `create or replace function public.branch_only_rpc() returns void language sql as $$ select 2; $$;`,
    );
    const earlierBranchFile = createMigrationFileDescriptor(
      '20260409120000_add_branch_rpc.sql',
      `create or replace function public.branch_only_rpc() returns void language sql as $$ select 1; $$;`,
    );

    const models = buildMigrationModels([latestFile, earlierBranchFile], []);

    expect(models[0]?.changeState).toBe('new');
    expect(models[0]?.comparisonVersion).toMatchObject({
      fileName: '20260409120000_add_branch_rpc.sql',
    });
  });

  it('sorts new and updated rpc entries before unchanged entries', () => {
    const models = buildMigrationModels(
      [
        createMigrationFileDescriptor(
          '20260409120000_alpha.sql',
          `create or replace function public.alpha_rpc() returns void language sql as $$ select 1; $$;`,
        ),
        createMigrationFileDescriptor(
          '20260409130000_beta.sql',
          `create or replace function public.beta_rpc() returns void language sql as $$ select 2; $$;`,
        ),
        createMigrationFileDescriptor(
          '20260409140000_gamma.sql',
          `create or replace function public.gamma_rpc() returns void language sql as $$ select 3; $$;`,
        ),
      ],
      [
        createMigrationFileDescriptor(
          '20260401120000_beta.sql',
          `create or replace function public.beta_rpc() returns void language sql as $$ select 1; $$;`,
        ),
        createMigrationFileDescriptor(
          '20260401130000_gamma.sql',
          `create or replace function public.gamma_rpc() returns void language sql as $$ select 3; $$;`,
        ),
      ],
    );

    expect(models.map((model) => [model.label, model.changeState])).toEqual([
      ['public.alpha_rpc', 'new'],
      ['public.beta_rpc', 'updated'],
      ['public.gamma_rpc', null],
    ]);
  });

  it('disables diff for new rpc entries even when an earlier branch migration exists', () => {
    const models = buildMigrationModels(
      [
        createMigrationFileDescriptor(
          '20260410120000_revise_branch_rpc.sql',
          `create or replace function public.branch_only_rpc() returns void language sql as $$ select 2; $$;`,
        ),
        createMigrationFileDescriptor(
          '20260409120000_add_branch_rpc.sql',
          `create or replace function public.branch_only_rpc() returns void language sql as $$ select 1; $$;`,
        ),
      ],
      [],
    );

    expect(hasComparisonMigration(models[0]!)).toBe(true);
    expect(canOpenRpcDiff(models[0]!)).toBe(false);
  });

  it('enables diff for updated rpc entries that compare against the branch base', () => {
    const models = buildMigrationModels(
      [
        createMigrationFileDescriptor(
          '20260409120000_update_rpc.sql',
          `create or replace function public.updated_rpc() returns void language sql as $$ select 2; $$;`,
        ),
      ],
      [
        createMigrationFileDescriptor(
          '20260408120000_update_rpc.sql',
          `create or replace function public.updated_rpc() returns void language sql as $$ select 1; $$;`,
        ),
      ],
    );

    expect(hasComparisonMigration(models[0]!)).toBe(true);
    expect(canOpenRpcDiff(models[0]!)).toBe(true);
  });

  it('diffs updated objects against the branch base even when an earlier workspace migration exists', () => {
    const models = buildMigrationModels(
      [
        createMigrationFileDescriptor(
          '20260410120000_revise_updated_view.sql',
          `create or replace view public.updated_view as select 3 as value;`,
        ),
        createMigrationFileDescriptor(
          '20260409120000_update_view.sql',
          `create or replace view public.updated_view as select 2 as value;`,
        ),
      ],
      [
        createMigrationFileDescriptor(
          '20260401120000_create_updated_view.sql',
          `create or replace view public.updated_view as select 1 as value;`,
        ),
      ],
    );

    expect(models[0]?.changeState).toBe('updated');
    expect(models[0]?.previousVersion).toMatchObject({
      fileName: '20260409120000_update_view.sql',
    });
    expect(models[0]?.comparisonVersion).toMatchObject({
      fileName: '20260401120000_create_updated_view.sql',
    });
    expect(canOpenRpcDiff(models[0]!)).toBe(true);
  });

  it('disables diff when no previous defining migration exists', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_add_new_rpc.sql',
        `create or replace function public.new_rpc() returns void language sql as $$ select; $$;`,
      ),
    ]);

    expect(hasComparisonMigration(models[0]!)).toBe(false);
    expect(canOpenRpcDiff(models[0]!)).toBe(false);
  });

  it('wraps related queries by migration and places version markers between helper queries', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260115121000_create_export_user_earnings_csv_rpc.sql',
        `drop function if exists public.export_user_earnings_csv(uuid);

create or replace function public.export_user_earnings_csv(p_user_id uuid)
returns text
language sql
as $$
  select 'csv';
$$;

comment on function public.export_user_earnings_csv(uuid)
  is 'Exports user earnings';

revoke all on function public.export_user_earnings_csv(uuid) from public;
grant execute on function public.export_user_earnings_csv(uuid) to service_role;`,
      ),
    ]);
    const content = getMigrationRelatedQueriesContent(models[0]!);

    expect(hasMigrationRelatedQueriesContent(models[0]!)).toBe(true);
    expect(content).toContain(
      '-- === BEGIN MIGRATION: 20260115121000_create_export_user_earnings_csv_rpc.sql ===',
    );
    expect(content).toContain('-- === RPC VERSION MARKER ===');
    expect(content).toContain('-- RPC: public.export_user_earnings_csv');
    expect(content).toContain(
      '-- Migration: 20260115121000_create_export_user_earnings_csv_rpc.sql',
    );
    expect(content).toContain(
      "comment on function public.export_user_earnings_csv(uuid)",
    );
    expect(content).toContain(
      'grant execute on function public.export_user_earnings_csv(uuid) to service_role;',
    );
    expect(content).not.toContain(
      "create or replace function public.export_user_earnings_csv",
    );

    expect(content.indexOf('drop function if exists public.export_user_earnings_csv(uuid);'))
      .toBeLessThan(content.indexOf('-- === RPC VERSION MARKER ==='));
    expect(content.indexOf('-- === RPC VERSION MARKER ==='))
      .toBeLessThan(content.indexOf("comment on function public.export_user_earnings_csv(uuid)"));
  });

  it('renders one marker block per migration that updated the selected object', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260408120000_create_random_miners_rpc.sql',
        `create or replace function public.random_miners()
returns int
language sql
as $$
  select 1;
$$;`,
      ),
      createMigrationFileDescriptor(
        '20260409120000_update_random_miners_rpc.sql',
        `comment on function public.random_miners() is 'before update';

create or replace function public.random_miners()
returns int
language sql
as $$
  select 2;
$$;

grant execute on function public.random_miners() to authenticated;`,
      ),
    ]);
    const content = getMigrationRelatedQueriesContent(models[0]!);

    expect(content.match(/-- === BEGIN MIGRATION:/g)).toHaveLength(2);
    expect(content.match(/-- === RPC VERSION MARKER ===/g)).toHaveLength(2);
    expect(content.indexOf('20260409120000_update_random_miners_rpc.sql'))
      .toBeLessThan(content.indexOf('20260408120000_create_random_miners_rpc.sql'));
    expect(content).toContain(
      '-- === END MIGRATION: 20260408120000_create_random_miners_rpc.sql ===',
    );
  });

  it('keeps marker-only migrations visible in related queries', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20251212120002_add_random_miners_rpc.sql',
        `create or replace function public.random_miners()
returns int
language sql
as $$
  select 1;
$$;`,
      ),
    ]);
    const content = getMigrationRelatedQueriesContent(models[0]!);

    expect(hasMigrationRelatedQueriesContent(models[0]!)).toBe(true);
    expect(content).toContain('-- === RPC VERSION MARKER ===');
    expect(content).toContain('-- RPC: public.random_miners');
    expect(content).toContain(
      '-- === END MIGRATION: 20251212120002_add_random_miners_rpc.sql ===',
    );
  });

  it('uses view markers for related queries of view migrations', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_create_wallet_summary_view.sql',
        `drop view if exists public.wallet_summary;

create or replace view public.wallet_summary as
select 'wallet' as label;

comment on view public.wallet_summary is 'Wallet summary';`,
      ),
    ]);
    const content = getMigrationRelatedQueriesContent(models[0]!);

    expect(content).toContain('-- === View VERSION MARKER ===');
    expect(content).toContain('-- View: public.wallet_summary');
    expect(content).toContain("comment on view public.wallet_summary is 'Wallet summary';");
    expect(content).not.toContain('create or replace view public.wallet_summary');
  });

});

describe('filterMigrationModels', () => {
  it('filters rpcs by fulltext across names and sql definitions', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_wallet_rpc.sql',
        `create or replace function public.process_wallet_exchange() returns void language sql as $$ select 'wallet'; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260409130000_user_rpc.sql',
        `create or replace function public.get_user_dashboard_mining_summary() returns void language sql as $$ select 'dashboard'; $$;`,
      ),
    ]);

    expect(filterMigrationModels(models, 'wallet').map((model) => model.label)).toEqual([
      'public.process_wallet_exchange',
    ]);
    expect(filterMigrationModels(models, 'dashboard').map((model) => model.label)).toEqual([
      'public.get_user_dashboard_mining_summary',
    ]);
  });

  it('filters by object kind when a type filter is selected', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260409120000_wallet_rpc.sql',
        `create or replace function public.process_wallet_exchange() returns void language sql as $$ select 'wallet'; $$;`,
      ),
      createMigrationFileDescriptor(
        '20260409130000_wallet_view.sql',
        `create or replace view public.wallet_summary as select 'wallet' as label;`,
      ),
    ]);

    expect(filterMigrationModels(models, '', 'rpcs').map((model) => model.kind)).toEqual([
      'rpc',
    ]);
    expect(filterMigrationModels(models, '', 'views').map((model) => model.kind)).toEqual([
      'view',
    ]);
    expect(filterMigrationModels(models, 'wallet', 'all').map((model) => model.kind)).toEqual([
      'rpc',
      'view',
    ]);
  });

  it('filters to new and updated objects when changed-only mode is enabled', () => {
    const models = buildMigrationModels(
      [
        createMigrationFileDescriptor(
          '20260409120000_alpha.sql',
          `create or replace function public.alpha_rpc() returns void language sql as $$ select 1; $$;`,
        ),
        createMigrationFileDescriptor(
          '20260409130000_beta.sql',
          `create or replace view public.beta_view as select 2 as value;`,
        ),
        createMigrationFileDescriptor(
          '20260409140000_gamma.sql',
          `create or replace function public.gamma_rpc() returns void language sql as $$ select 3; $$;`,
        ),
      ],
      [
        createMigrationFileDescriptor(
          '20260401130000_beta.sql',
          `create or replace view public.beta_view as select 1 as value;`,
        ),
        createMigrationFileDescriptor(
          '20260401140000_gamma.sql',
          `create or replace function public.gamma_rpc() returns void language sql as $$ select 3; $$;`,
        ),
      ],
    );

    expect(filterMigrationModels(models, '', 'all', true).map((model) => model.label)).toEqual([
      'public.alpha_rpc',
      'public.beta_view',
    ]);
    expect(filterMigrationModels(models, '', 'views', true).map((model) => model.label)).toEqual([
      'public.beta_view',
    ]);
  });

  it('filters by helper SQL from older object migrations', () => {
    const models = buildMigrationModels([
      createMigrationFileDescriptor(
        '20260408120000_create_wallet_rpc.sql',
        `create or replace function public.process_wallet_exchange() returns void language sql as $$ select 'wallet'; $$;

grant execute on function public.process_wallet_exchange() to service_role;`,
      ),
      createMigrationFileDescriptor(
        '20260409120000_update_wallet_rpc.sql',
        `create or replace function public.process_wallet_exchange() returns void language sql as $$ select 'updated'; $$;`,
      ),
    ]);

    expect(filterMigrationModels(models, 'service_role').map((model) => model.label)).toEqual([
      'public.process_wallet_exchange',
    ]);
  });
});

describe('normalizeSqlForDiff', () => {
  it('normalizes indentation and trailing whitespace for both diff sides', () => {
    expect(
      normalizeSqlForDiff(`
        create or replace function public.test_rpc()
          returns void
          language sql
        as $$
        begin    
          select 1;    
        end;
        $$;
      `),
    ).toBe(
      [
        'create or replace function public.test_rpc()',
        '  returns void',
        '  language sql',
        'as $$',
        'begin',
        '  select 1;',
        'end;',
        '$$;',
      ].join('\n'),
    );
  });
});

describe('getSearchEmptyState', () => {
  it('returns a dedicated empty state for searches', () => {
    expect(getSearchEmptyState('wallet')).toEqual({
      label: 'No RPC functions or views match the search',
      message: 'No Supabase RPC functions or views matched "wallet".',
    });
  });

  it('returns a type-aware empty state for filtered searches', () => {
    expect(getFilteredSearchEmptyState('wallet', 'views')).toEqual({
      label: 'No views match the search',
      message: 'No Supabase views matched "wallet".',
    });
  });

  it('returns changed-only guidance for filtered searches when unchanged objects are hidden', () => {
    expect(getFilteredSearchEmptyState('wallet', 'views', true)).toEqual({
      label: 'No views match the search',
      message:
        'No Supabase views matched "wallet". Clear Show only new or updated to include unchanged objects in the search.',
    });
  });
});

describe('getEmptyState', () => {
  it('returns the missing-folder empty state when no migrations folder exists', () => {
    expect(
      getEmptyState({
        hasMigrationsFolder: false,
        hasSqlFiles: false,
      }),
    ).toEqual({
      label: 'No supabase/migrations folder found',
      message:
        'Open a workspace that contains supabase/migrations to browse Supabase RPC functions here.',
    });
  });

  it('returns the no-rpc empty state when the folder exists but contains no rpc functions', () => {
    expect(
      getEmptyState({
        hasMigrationsFolder: true,
        hasSqlFiles: false,
      }),
    ).toEqual({
      label: 'No Supabase RPCs or views found',
      message:
        'The workspace contains supabase/migrations, but no SQL migration currently defines a Supabase RPC function or view.',
    });
  });

  it('returns a type-filter empty state when objects exist but the selected type does not', () => {
    expect(
      getEmptyState({
        hasMigrationsFolder: true,
        hasSqlFiles: true,
        hasFilteredItems: false,
        kindFilter: 'views',
      }),
    ).toEqual({
      label: 'No Supabase views found',
      message:
        'No Supabase views matched the current type filter. Choose All to show every discovered RPC and view.',
    });
  });

  it('returns a changed-only empty state when no objects changed against the selected branch', () => {
    expect(
      getEmptyState({
        hasMigrationsFolder: true,
        hasSqlFiles: true,
        hasFilteredItems: false,
        showOnlyChanged: true,
      }),
    ).toEqual({
      label: 'No new or updated RPC functions or views found',
      message:
        'No Supabase RPC functions or views changed compared with the selected branch. Clear Show only new or updated to browse unchanged objects too.',
    });
  });

  it('returns null when sql migration files are available', () => {
    expect(
      getEmptyState({
        hasMigrationsFolder: true,
        hasSqlFiles: true,
      }),
    ).toBeNull();
  });
});