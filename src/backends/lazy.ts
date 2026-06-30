import { MissingDriverError } from '../types.js';

/**
 * Lazily import an OPTIONAL driver. Resolves the module the first time a
 * backend that needs it is actually constructed, so the local filesystem
 * backend stays zero-dependency. A genuinely-missing package is mapped to a
 * clear {@link MissingDriverError} ("install X"); any other import failure
 * (e.g. a broken native build) is rethrown untouched.
 *
 * @param specifier  the module specifier to import (usually === pkg)
 * @param pkg        the npm package name to suggest installing
 * @param forWhat    human description, e.g. "the SQLite backend"
 */
export async function loadDriver<T>(specifier: string, pkg: string, forWhat: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (err) {
    if (isModuleNotFound(err, specifier)) {
      throw new MissingDriverError(pkg, forWhat);
    }
    throw err;
  }
}

function isModuleNotFound(err: unknown, specifier: string): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  // Some loaders surface this only in the message:
  //  - Node:  "Cannot find package 'x'" / "Cannot find module 'x'"
  //  - Vite/vitest: "Failed to load url x (resolved id: x). Does the file exist?"
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes(`Cannot find package '${specifier}'`) ||
    msg.includes(`Cannot find module '${specifier}'`) ||
    (msg.includes('Failed to load url') && msg.includes(specifier))
  );
}
