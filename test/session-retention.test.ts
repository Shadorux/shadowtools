import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

it('runs one startup retention prune without a recurring maintenance timer', async () => {
  const source = await readFile(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  expect(source).not.toContain('startSessionRetentionMaintenance');
  expect(source).toContain('pruneSessions(getConfig().sessions.retainDays)');
  await expect(stat(path.join(process.cwd(), 'src/main/session/retention.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});
