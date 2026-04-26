import blessed from 'neo-blessed';

import type { TuiFocusPane } from './state.js';

export type Widgets = {
  screen: blessed.Widgets.Screen;
  header: blessed.Widgets.BoxElement;
  clusters: blessed.Widgets.ListElement;
  members: blessed.Widgets.ListElement;
  detail: blessed.Widgets.BoxElement;
  footer: blessed.Widgets.BoxElement;
};

export type MouseEventArg = blessed.Widgets.Events.IMouseEventArg & {
  button?: 'left' | 'middle' | 'right' | 'unknown';
};

export function resolveBlessedTerminal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const term = env.TERM;
  if (!term) {
    return undefined;
  }
  if (term === 'xterm-ghostty') {
    return 'xterm-256color';
  }
  return term;
}

export function createScreen(options: Parameters<typeof blessed.screen>[0]): blessed.Widgets.Screen {
  return blessed.screen({
    ...options,
    terminal: resolveBlessedTerminal(),
  });
}

export function createWidgets(owner: string, repo: string): Widgets {
  const screen = createScreen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false,
    mouse: true,
    title: owner && repo ? `ghcrawl ${owner}/${repo}` : 'ghcrawl',
  });
  const header = blessed.box({
    parent: screen,
    tags: true,
    mouse: true,
    style: { fg: 'white', bg: '#0d1321' },
  });
  const clusters = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Clusters ',
    tags: true,
    keys: false,
    mouse: true,
    style: {
      border: { fg: '#5bc0eb' },
      item: { fg: 'white' },
      selected: { bg: '#5bc0eb', fg: 'black', bold: true },
    },
    scrollbar: { ch: ' ' },
  });
  const members = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Members ',
    tags: true,
    keys: false,
    mouse: true,
    style: {
      border: { fg: '#9bc53d' },
      item: { fg: 'white' },
      selected: { bg: '#9bc53d', fg: 'black', bold: true },
    },
  });
  const detail = blessed.box({
    parent: screen,
    border: 'line',
    label: ' Detail ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: false,
    mouse: true,
    style: {
      border: { fg: '#fde74c' },
      fg: 'white',
    },
  });
  const footer = blessed.box({
    parent: screen,
    tags: false,
    mouse: true,
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  return { screen, header, clusters, members, detail, footer };
}

export function updatePaneStyles(widgets: Widgets, focus: TuiFocusPane): void {
  widgets.clusters.setLabel(`${focus === 'clusters' ? '[*]' : '[ ]'} Clusters `);
  widgets.members.setLabel(`${focus === 'members' ? '[*]' : '[ ]'} Members `);
  widgets.detail.setLabel(`${focus === 'detail' ? '[*]' : '[ ]'} Detail `);
  widgets.clusters.style.border = { fg: focus === 'clusters' ? 'white' : '#5bc0eb' };
  widgets.members.style.border = { fg: focus === 'members' ? 'white' : '#9bc53d' };
  widgets.detail.style.border = { fg: focus === 'detail' ? 'white' : '#fde74c' };
  widgets.clusters.style.selected =
    focus === 'clusters' ? { bg: '#f7f7ff', fg: 'black', bold: true } : { bg: '#23445c', fg: 'white', bold: true };
  widgets.members.style.selected =
    focus === 'members' ? { bg: '#f7f7ff', fg: 'black', bold: true } : { bg: '#33521e', fg: 'white', bold: true };
}

export function applyRect(element: blessed.Widgets.BoxElement | blessed.Widgets.ListElement, rect: { top: number; left: number; width: number; height: number }): void {
  element.top = rect.top;
  element.left = rect.left;
  element.width = rect.width;
  element.height = rect.height;
}

export function getListItemIndexFromMouse(list: blessed.Widgets.ListElement, event: MouseEventArg): number | null {
  const itemIndex = Number(event.y) - Number(list.atop) - 2 + Number(list.getScroll());
  return Number.isInteger(itemIndex) ? itemIndex : null;
}
