import { constants, copyFileSync, linkSync, openSync, unlinkSync } from 'node:fs';

/** Retry only a name collision. The operation must create its destination exclusively. */
export function createExclusive<T>(nextPath: () => string, create: (path: string) => T): { path: string; value: T } {
  for (;;) {
    const path = nextPath();
    try {
      return { path, value: create(path) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; // failure-class: operational
    }
  }
}

export function openExclusive(nextPath: () => string): { path: string; value: number } {
  return createExclusive(nextPath, path => openSync(path, 'wx'));
}

export function copyExclusive(source: string, nextPath: () => string): string {
  return createExclusive(nextPath, path => copyFileSync(source, path, constants.COPYFILE_EXCL)).path;
}

/** Same-filesystem no-replace move: link publishes atomically without rename's overwrite semantics. */
export function moveExclusive(source: string, nextPath: () => string): string {
  const { path } = createExclusive(nextPath, path => linkSync(source, path));
  unlinkSync(source);
  return path;
}
