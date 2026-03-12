import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterCommands,
  formatCommandLabel,
  normalizeSlashQuery,
  resolveCommands,
  selectCommandFromQuery,
  type TuiCommandDefinition,
} from './commands.js';
import type { TuiScreenId } from './state.js';

type CommandContext = {
  activeScreen: TuiScreenId;
};

function buildCommands(): TuiCommandDefinition<CommandContext>[] {
  return [
    {
      id: 'view.clusters',
      slash: 'clusters',
      label: 'Clusters Explorer',
      description: 'Switch to the clusters explorer.',
      aliases: ['cluster', 'home'],
      execute: () => {},
    },
    {
      id: 'view.users',
      slash: 'users',
      label: 'User Explorer',
      description: 'Switch to the user explorer.',
      aliases: ['user'],
      execute: () => {},
    },
    {
      id: 'view.filter',
      slash: 'filter',
      label: 'Filter Clusters',
      description: 'Filter clusters by title and member text.',
      screens: ['clusters'],
      execute: () => {},
    },
    {
      id: 'future.template-drift',
      slash: 'template-drift',
      label: 'Template Drift',
      description: 'Inspect PRs whose template text barely changed.',
      getAvailability: () => ({ enabled: false, reason: 'coming soon' }),
      execute: () => {},
    },
  ];
}

test('normalizeSlashQuery strips the leading slash and lowercases input', () => {
  assert.equal(normalizeSlashQuery('/Users'), 'users');
  assert.equal(normalizeSlashQuery('  /FILTER '), 'filter');
});

test('filterCommands ranks exact, prefix, and fuzzy matches in that order', () => {
  const resolved = resolveCommands(buildCommands(), { activeScreen: 'clusters' });

  assert.equal(filterCommands(resolved, '/users')[0]?.definition.slash, 'users');
  assert.deepEqual(filterCommands(resolved, '/cl').map((command) => command.definition.slash).slice(0, 2), ['clusters', 'filter']);
  assert.equal(filterCommands(resolved, 'usr').some((command) => command.definition.slash === 'users'), true);
});

test('resolveCommands hides commands outside the active screen scope', () => {
  const resolved = resolveCommands(buildCommands(), { activeScreen: 'users' });

  assert.equal(resolved.some((command) => command.definition.slash === 'filter'), false);
  assert.deepEqual(filterCommands(resolved, '').map((command) => command.definition.slash), [
    'clusters',
    'users',
    'template-drift',
  ]);
});

test('selectCommandFromQuery prefers an exact alias match over the highlighted result', () => {
  const resolved = resolveCommands(buildCommands(), { activeScreen: 'clusters' });
  const selected = selectCommandFromQuery(resolved, '/user', 0);

  assert.equal(selected?.definition.slash, 'users');
});

test('formatCommandLabel marks unavailable commands with the reason', () => {
  const [command] = filterCommands(resolveCommands(buildCommands(), { activeScreen: 'clusters' }), 'template');

  assert.match(formatCommandLabel(command), /coming soon/);
  assert.match(formatCommandLabel(command), /gray-fg/);
});
