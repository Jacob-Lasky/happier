import { basename, dirname, join } from 'node:path';

function normalizePathLike(pathLike: string): string {
  return String(pathLike ?? '').trim().replaceAll('\\', '/');
}

function isRuntimeExecutablePath(pathLike: string): boolean {
  const base = basename(normalizePathLike(pathLike)).toLowerCase();
  return base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
}

function resolveCliInstallRootNameFromShim(executableBase: string): string | null {
  const normalizedBase = executableBase.toLowerCase().replace(/\.exe$/u, '');
  if (normalizedBase === 'happier') return 'cli';
  if (normalizedBase === 'hprev') return 'cli-preview';
  if (normalizedBase === 'hdev') return 'cli-dev';
  return null;
}

export function isSelfContainedCliBinary(execPath: string = process.execPath): boolean {
  const normalized = normalizePathLike(execPath);
  if (!normalized) return false;
  return !isRuntimeExecutablePath(normalized);
}

function resolveInstalledCliRuntimeRootPath(execPath: string): string | null {
  const normalized = normalizePathLike(execPath);
  if (!normalized || !isSelfContainedCliBinary(normalized)) {
    return null;
  }

  const installRootName = resolveCliInstallRootNameFromShim(basename(normalized));
  if (!installRootName) {
    return null;
  }

  const binaryDir = dirname(normalized);
  if (basename(binaryDir).toLowerCase() !== 'bin') {
    return null;
  }

  return join(dirname(binaryDir), installRootName, 'current');
}

/**
 * Runtime root of a self-contained first-party binary: the installed `<home>/<cli root>/current`
 * payload when launched through a `<home>/bin` CLI shortcut (shortcuts are hardlinks or copies,
 * so `execPath` is the shortcut), otherwise the binary's own directory. `null` for node/bun.
 */
export function resolveSelfContainedCliRuntimeRootPath(execPath: string = process.execPath): string | null {
  const installedCliRuntimeRoot = resolveInstalledCliRuntimeRootPath(execPath);
  if (installedCliRuntimeRoot) return installedCliRuntimeRoot;
  const normalized = normalizePathLike(execPath);
  return isSelfContainedCliBinary(normalized) ? dirname(normalized) : null;
}
