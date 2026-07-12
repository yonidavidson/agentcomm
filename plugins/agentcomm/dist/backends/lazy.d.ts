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
export declare function loadDriver<T>(specifier: string, pkg: string, forWhat: string): Promise<T>;
//# sourceMappingURL=lazy.d.ts.map