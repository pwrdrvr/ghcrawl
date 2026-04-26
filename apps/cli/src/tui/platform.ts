import { spawn, spawnSync } from 'node:child_process';

export function openUrl(url: string): void {
  const launch =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] };
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: process.platform === 'win32',
  });
  child.unref();
}

export function copyTextToClipboard(value: string): boolean {
  const copyCommand =
    process.platform === 'darwin'
      ? { command: 'pbcopy', args: [] }
      : process.platform === 'win32'
        ? { command: 'clip', args: [] }
        : { command: 'xclip', args: ['-selection', 'clipboard'] };
  const result = spawnSync(copyCommand.command, copyCommand.args, {
    input: value,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  return result.status === 0;
}
