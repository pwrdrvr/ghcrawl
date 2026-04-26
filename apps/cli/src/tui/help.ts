import blessed from 'neo-blessed';

import type { MouseEventArg } from './widgets.js';

export function buildHelpContent(): string {
  return [
    '{bold}ghcrawl TUI Help{/bold}',
    '',
    '{bold}Navigation{/bold}',
    'Tab / Shift-Tab  cycle focus across clusters, members, and detail',
    'Left / Right      cycle focus backward or forward across panes',
    'Up / Down         move selection, or scroll detail when detail is focused',
    'Enter             clusters -> members, members -> detail',
    'Mouse             click to focus/select; click list headers to sort; right-click opens pane actions; wheel scrolls',
    'PgUp / PgDn       page through the focused pane or this help popup faster',
    'Home / End        jump to the top or bottom of detail or help',
    '',
    '{bold}Views And Filters{/bold}',
    '#                 jump directly to an issue or PR number',
    's                 cycle cluster sort mode',
    'm                 cycle member sort mode',
    'f                 cycle minimum cluster size filter',
    'l                 toggle wide layout: columns vs. wide-left stacked-right',
    'x                 show or hide locally closed clusters and members',
    '/                 filter clusters by title/member text',
    'r                 refresh the current local view from SQLite',
    '',
    '{bold}Actions{/bold}',
    'p                 open the repository browser / select another local repository',
    'o                 open the selected thread URL in your browser',
    '',
    '{bold}Help And Exit{/bold}',
    'h or ?            open this help popup',
    'q                 quit the TUI or close this popup',
    'Esc               close this popup',
    '',
    '{bold}Notes{/bold}',
    'The TUI only reads local SQLite. Run ghcrawl sync, ghcrawl embed, and ghcrawl cluster from the shell to update data.',
    'The default cluster filter is 1+, so solo clusters are visible unless you raise it with f.',
    'The default sort is size. Press s to toggle size and recent.',
    'Member rows default to issue/PR grouping. Press m or click the member header to sort by updated, number, state, or title.',
    'Mouse clicks focus panes; clicking an already selected row advances to the next pane. Right-click works on every pane.',
    'Clusters show C<clusterId> so the cluster id is easy to copy into CLI or skill flows.',
    'The footer only shows the short command list. Open help to see the full list.',
    'This popup scrolls. Use arrows, PgUp/PgDn, Home, and End if it does not fit.',
  ].join('\n');
}

export async function promptHelp(screen: blessed.Widgets.Screen): Promise<void> {
  const modalWidth = '86%';
  const box = blessed.box({
    parent: screen,
    border: 'line',
    label: ' Help ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    top: 'center',
    left: 'center',
    width: modalWidth,
    height: '80%',
    padding: {
      left: 1,
      right: 1,
    },
    scrollbar: {
      ch: ' ',
    },
    style: {
      border: { fg: '#5bc0eb' },
      fg: 'white',
      bg: '#101522',
      scrollbar: { bg: '#5bc0eb' },
    },
    content: buildHelpContent(),
  });
  const help = blessed.box({
    parent: screen,
    width: modalWidth,
    height: 1,
    bottom: 1,
    left: 'center',
    tags: false,
    content: 'Scroll with arrows, PgUp/PgDn, Home, End. Press Esc, q, h, ?, or Enter to close.',
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  box.focus();
  box.setScroll(0);
  screen.render();

  return await new Promise<void>((resolve) => {
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      screen.off('keypress', handleKeypress);
      screen.off('mousedown', handleMouse);
      box.destroy();
      help.destroy();
      screen.render();
      resolve();
    };
    const handleKeypress = (char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'escape' || key.name === 'enter' || key.name === 'q' || key.name === 'h' || char === '?') {
        finish();
        return;
      }
      if (key.name === 'pageup') {
        box.scroll(-12);
        screen.render();
        return;
      }
      if (key.name === 'pagedown') {
        box.scroll(12);
        screen.render();
        return;
      }
      if (key.name === 'home') {
        box.setScroll(0);
        screen.render();
        return;
      }
      if (key.name === 'end') {
        box.setScrollPerc(100);
        screen.render();
      }
    };
    const handleMouse = (event: MouseEventArg): void => {
      if (event.button === 'right') {
        finish();
      }
    };

    screen.on('keypress', handleKeypress);
    screen.on('mousedown', handleMouse);
  });
}
