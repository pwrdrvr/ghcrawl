import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { writeHeapSnapshot } from 'node:v8';

export type HeapDiagnosticsOptions = {
  snapshotDir?: string;
  logIntervalMs?: number;
  log: (message: string) => void;
};

export type HeapDiagnostics = {
  wrapProgress(onProgress?: (message: string) => void): (message: string) => void;
  capture(label: string): string | null;
  dispose(): void;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function sanitizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'snapshot';
}

export function formatMemoryUsage(usage: NodeJS.MemoryUsage = process.memoryUsage()): string {
  return `rss=${formatBytes(usage.rss)} heap_used=${formatBytes(usage.heapUsed)} heap_total=${formatBytes(usage.heapTotal)} external=${formatBytes(usage.external)} array_buffers=${formatBytes(usage.arrayBuffers)}`;
}

export function createHeapDiagnostics(options: HeapDiagnosticsOptions): HeapDiagnostics {
  const snapshotDir = options.snapshotDir ? path.resolve(options.snapshotDir) : null;
  if (snapshotDir) {
    mkdirSync(snapshotDir, { recursive: true });
  }

  let sawClusterProgress = false;
  let interval: NodeJS.Timeout | null = null;
  const signal = 'SIGUSR2';
  const unsafeCapture = (label: string): string | null => {
    if (!snapshotDir) {
      return null;
    }
    const timestamp = new Date().toISOString().replace(/[:]/g, '-');
    const filename = path.join(snapshotDir, `${timestamp}-${sanitizeLabel(label)}.heapsnapshot`);
    return writeHeapSnapshot(filename);
  };

  const capture = (label: string): string | null => {
    try {
      return unsafeCapture(label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log(`[heap] failed to write snapshot for ${label}: ${message}`);
      return null;
    }
  };

  const signalHandler = (): void => {
    const file = capture('signal-sigusr2');
    options.log(file ? `[heap] wrote heap snapshot on ${signal}: ${file}` : `[heap] ${signal} received but snapshot output is disabled`);
  };

  process.on(signal, signalHandler);
  options.log(
    `[heap] diagnostics enabled pid=${process.pid} signal=${signal}` +
      (snapshotDir ? ` snapshot_dir=${snapshotDir}` : '') +
      (options.logIntervalMs ? ` log_interval_ms=${options.logIntervalMs}` : ''),
  );
  options.log(`[heap] start ${formatMemoryUsage()}`);

  if (snapshotDir) {
    const file = capture('command-start');
    options.log(`[heap] wrote heap snapshot: ${file}`);
  }

  if (options.logIntervalMs && options.logIntervalMs > 0) {
    interval = setInterval(() => {
      options.log(`[heap] sample ${formatMemoryUsage()}`);
    }, options.logIntervalMs);
    interval.unref();
  }

  return {
    wrapProgress(onProgress?: (message: string) => void): (message: string) => void {
      return (message: string) => {
        if (!sawClusterProgress && message.startsWith('[cluster]')) {
          sawClusterProgress = true;
          options.log(`[heap] cluster-start ${formatMemoryUsage()}`);
          if (snapshotDir) {
            const file = capture('cluster-start');
            options.log(`[heap] wrote heap snapshot: ${file}`);
          }
        }
        onProgress?.(message);
      };
    },
    capture(label: string): string | null {
      const file = capture(label);
      options.log(`[heap] ${label} ${formatMemoryUsage()}`);
      if (file) {
        options.log(`[heap] wrote heap snapshot: ${file}`);
      }
      return file;
    },
    dispose(): void {
      if (interval) {
        clearInterval(interval);
      }
      process.off(signal, signalHandler);
    },
  };
}
