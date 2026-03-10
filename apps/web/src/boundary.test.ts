import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('web package does not depend on api-core', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };

  assert.equal(packageJson.dependencies?.['@ghcrawl/api-core'], undefined);
  assert.equal(packageJson.dependencies?.['@ghcrawl/api-contract'], 'workspace:*');
});
