# Releasing

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Each release is a version tag, a GitHub release and an npm version of `@coywolf/emdash`. Release only from a commit of `main` whose CI run is green: a failure found after the tag and the GitHub release exist leaves a public release with no npm package.

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (they must match; `test/version.test.mjs` checks), and run `npm install --package-lock-only`.
2. Merge to `main` and wait for [CI](#ci) on the merge commit to pass (`gh run list --workflow ci.yml --branch main`, or the commit's checks on GitHub). Then tag the merge commit: `git tag -a v0.35.14 -m "…"` and `git push origin v0.35.14`.
3. Publish the GitHub release for the tag (`gh release create v0.35.14 --latest --verify-tag --notes-file …`), with the intro, the five bullets, **What's new** and the install guide.
4. Publishing the release runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml): it checks that the tag matches `package.json`, runs the type check and tests again, and publishes to npm with a provenance statement. Run it again by hand from the Actions tab (**Publish to npm → Run workflow**, with the tag) if it failed.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request, every push to `main`, weekly on Mondays (so a new EmDash release is tested even without a push), and by hand from the Actions tab. Each job runs `npm ci`, `npx tsc --noEmit` and `npm test` on Node 24, the version `publish.yml` uses.

**The matrix.** The pack's admin pages render inside EmDash's admin and share its Kumo, so a site always has the exact Kumo version its EmDash's admin pins. CI tests only those combinations:

| Job | EmDash | Kumo | Runs |
| --- | --- | --- | --- |
| The sites | 1.5.0 | 2.15.0 | Always |
| Latest EmDash | the newest release | 2.15.0 | While the newest release pins Kumo 2.15.0 (EmDash 1.5.0 does) |

A latest job whose Kumo isn't the newest release's pin ends early with a notice, and a pin that no job covers fails the run. While the sites run the newest release, the two jobs test the same versions.

**Versions and the lockfile.** `npm ci` fails when `package-lock.json` doesn't match `package.json`. The lockfile must install a valid combination too: the next step fails if its Kumo isn't the one its EmDash's admin pins. Each job then installs its EmDash and Kumo with `npm install --no-save` (skipped when the lockfile already has them) and checks that `package.json` and `package-lock.json` are unchanged.

**When EmDash moves.**

- When the sites move to a new EmDash, change the sites job's `emdash` (and `kumo`, if the pin changed) in `ci.yml`.
- When EmDash's admin pins a new Kumo, set the `@cloudflare/kumo` devDependency to that exact version. Dependabot doesn't update Kumo, and CI fails until it matches. Then add a `latest` job for the new pin (and its Kumo to `LATEST_KUMO_ROWS`), and drop the `latest` job no release pins anymore. When the sites move to a new EmDash, update the sites job and the site-stack devDependencies (EmDash, Astro, React, Zod, Kumo) by hand: Dependabot leaves them alone.

**What the tests check against EmDash.** `test/admin-classes.test.mjs` checks the admin pages' class names against the installed EmDash's admin stylesheet. `test/emdash-contract.test.mjs` checks the EmDash internals the pack relies on: its tables and columns, plugin APIs, admin patches and page metadata (the list is in [Internals](internals.md#emdash-internals-the-pack-relies-on)).

## Dependencies

[`.github/dependabot.yml`](../.github/dependabot.yml) opens one pull request a week for the npm devDependencies and one for the GitHub Actions versions, each tested by CI. It raises the devDependency ranges in `package.json` to the versions it installs. It leaves `peerDependencies` (the ranges sites may install) alone: change those by hand. It also skips `@cloudflare/kumo` (see above) and TypeScript majors.

## npm setup (once)

The workflow uses npm trusted publishing: npm accepts publishes from this repository's workflow without any stored token.

1. The npm account `coywolf` owns the `@coywolf` scope (a user's scope; no organization needed).
2. The first version is published by hand, because npm sets up a trusted publisher only for a package that exists. From a clean checkout of the release tag, signed in to npm as `coywolf`: `npm publish --access public` (npm asks for the two-factor code).
3. On npmjs.com, open `@coywolf/emdash` → **Settings** → **Trusted publishing**, choose **GitHub Actions**, and enter organization `coywolf-llc`, repository `coywolf-pack`, workflow `publish.yml` (no environment). Done for 0.35.13; 0.35.14 was the first version the workflow published.
4. Optional, recommended: in the package's **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working.

npm reviews a new package's first versions before they're public: until then `npm view` reports the package as not found and the package page shows a "Temporary Holding Version". A new trusted publisher shows **Pending validation** until the workflow publishes through it once.
