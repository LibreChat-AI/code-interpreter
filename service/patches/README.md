# Dependency security patches

Install with Bun 1.4.4 and the committed lockfile. The service Dockerfiles copy
this directory before installing dependencies so development, build, and
production installs apply the same patches. Do not replace these installs with
`npm install`: npm does not apply Bun's `patchedDependencies`.

## deepmerge 4.3.1

[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
has no patched release. The Rollup resolver brings in this build dependency.
The patch defines destination keys as own data properties instead of invoking
inherited setters, including `__proto__`. It covers the source and both shipped
CommonJS/UMD builds while retaining normal objects, recursive merges, symbols,
and concatenated arrays.

`bun audit` still reports the original version. This warning is not suppressed;
remove the patch only after adopting and testing a fixed upstream release.
Regression tests are in `src/dependency-security.test.ts`.

## MinIO 8.0.7 / stream-json 3.9.0

MinIO still requests stream-json 1.x. The scoped override installs patched
stream-json 3.9.0; the MinIO patch adapts its sole parser call site to the new
lowercase module path and Node stream adapter. Both the CommonJS and ESM builds
are patched, together with the TypeScript source. A version override alone would
break MinIO imports and notification parsing.

`scripts/dependency-compat.test.cjs` checks both MinIO builds under Node and Bun,
including split UTF-8 records and malformed JSON. Existing MinIO upload and
listing tests cover the storage operations used by the service. Remove the
patch and override after MinIO ships a compatible patched parser dependency.

## minimatch

Only typescript-estree's minimatch dependency is upgraded to 11.0.1. Older
ESLint/glob callers retain the compatible callable v3 API. The deprecated
`@types/minimatch` stub is replaced with 5.1.2, which provides declarations
without installing an unnecessary runtime minimatch dependency.
