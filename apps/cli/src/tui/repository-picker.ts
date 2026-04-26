import blessed from 'neo-blessed';

import type { GHCrawlService } from '@ghcrawl/api-core';

import { formatRelativeTime } from './state.js';
import type { MouseEventArg } from './widgets.js';

export type RepositoryTarget = {
  owner: string;
  repo: string;
};

export type RepositoryChoice =
  | {
      kind: 'existing';
      target: RepositoryTarget;
      label: string;
    }
  | {
      kind: 'new';
      label: string;
    };

export function getRepositoryChoices(service: Pick<GHCrawlService, 'listRepositories'>, now: Date = new Date()): RepositoryChoice[] {
  const repositories = service.listRepositories().repositories
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.fullName.localeCompare(right.fullName));

  return [
    ...repositories.map((repository) => ({
      kind: 'existing' as const,
      target: { owner: repository.owner, repo: repository.name },
      label: `${repository.fullName}  ${formatRelativeTime(repository.updatedAt, now)}`,
    })),
    { kind: 'new' as const, label: '+ Select another repository path' },
  ];
}

export async function promptRepositoryChoice(
  screen: blessed.Widgets.Screen,
  service: GHCrawlService,
): Promise<RepositoryChoice | null> {
  const choices = getRepositoryChoices(service);
  const box = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Repositories ',
    keys: true,
    vi: true,
    mouse: true,
    top: 'center',
    left: 'center',
    width: '70%',
    height: '70%',
    style: {
      border: { fg: '#5bc0eb' },
      item: { fg: 'white' },
      selected: { bg: '#5bc0eb', fg: 'black', bold: true },
    },
    items: choices.map((choice) => choice.label),
  });
  const help = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Select a repository with Enter. Press n for a new repo. Esc cancels.',
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  box.focus();
  box.select(0);
  screen.render();

  return await new Promise<RepositoryChoice | null>((resolve) => {
    let closed = false;
    const teardown = (): void => {
      if (closed) return;
      closed = true;
      screen.off('keypress', handleKeypress);
      screen.off('mousedown', handleMouse);
      box.destroy();
      help.destroy();
      screen.render();
    };
    const finish = (value: RepositoryChoice | null): void => {
      teardown();
      resolve(value);
    };
    const handleKeypress = (_char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'escape' || key.name === 'q') {
        finish(null);
        return;
      }
      if (key.name === 'n') {
        const newIndex = choices.findIndex((choice) => choice.kind === 'new');
        if (newIndex >= 0) {
          box.select(newIndex);
          screen.render();
        }
      }
    };
    const handleMouse = (event: MouseEventArg): void => {
      if (event.button === 'right') {
        finish(null);
      }
    };

    screen.on('keypress', handleKeypress);
    screen.on('mousedown', handleMouse);
    box.on('select', (_item, index) => finish(choices[index] ?? null));
  });
}

export async function promptRepositoryInput(screen: blessed.Widgets.Screen): Promise<RepositoryTarget | null> {
  const prompt = blessed.prompt({
    parent: screen,
    border: 'line',
    height: 7,
    width: '60%',
    top: 'center',
    left: 'center',
    label: ' Repository ',
    tags: true,
    keys: true,
    vi: true,
    style: {
      border: { fg: 'cyan' },
      bg: '#101522',
    },
  });

  return await new Promise<RepositoryTarget | null>((resolve) => {
    let closed = false;
    const finish = (value: RepositoryTarget | null): void => {
      if (closed) return;
      closed = true;
      screen.off('mousedown', handleMouse);
      prompt.destroy();
      screen.render();
      resolve(value);
    };
    const handleMouse = (event: MouseEventArg): void => {
      if (event.button === 'right') {
        finish(null);
      }
    };

    screen.on('mousedown', handleMouse);
    prompt.key(['escape'], () => finish(null));
    prompt.input('Repository to open (owner/repo)', '', (_error, value) => {
      const parsed = parseOwnerRepoValue((value ?? '').trim());
      finish(parsed);
    });
  });
}

export function parseOwnerRepoValue(value: string): RepositoryTarget | null {
  const parts = value.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}
