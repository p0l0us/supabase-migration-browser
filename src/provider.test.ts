import { describe, expect, it } from 'vitest';

import { parseGitPathList, parseGitStatusPaths } from './git-status';

describe('parseGitStatusPaths', () => {
  it('collects modified, added, and untracked migration paths from git porcelain output', () => {
    const stdout = [
      ' M supabase/migrations/20260409120000_update_rpc.sql',
      'A  supabase/migrations/20260409130000_add_rpc.sql',
      '?? supabase/migrations/20260409140000_new_rpc.sql',
    ].join('\n');

    expect([...parseGitStatusPaths(stdout)]).toEqual([
      'supabase/migrations/20260409120000_update_rpc.sql',
      'supabase/migrations/20260409130000_add_rpc.sql',
      'supabase/migrations/20260409140000_new_rpc.sql',
    ]);
  });

  it('uses the destination path for renamed migration files', () => {
    const stdout = 'R  supabase/migrations/old_name.sql -> supabase/migrations/new_name.sql';

    expect([...parseGitStatusPaths(stdout)]).toEqual([
      'supabase/migrations/new_name.sql',
    ]);
  });

  it('parses newline-delimited git path lists', () => {
    const stdout = [
      'supabase/migrations/20260409120000_update_rpc.sql',
      '',
      'supabase/migrations/20260409130000_add_rpc.sql',
    ].join('\n');

    expect(parseGitPathList(stdout)).toEqual([
      'supabase/migrations/20260409120000_update_rpc.sql',
      'supabase/migrations/20260409130000_add_rpc.sql',
    ]);
  });
});