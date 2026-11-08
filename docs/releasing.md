# Releasing

[Coywolf Pack documentation](README.md) · [Getting started](../README.md#getting-started)

Each release is a version tag, a GitHub release and an npm version of `@coywolf/emdash`.

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (they must match), and run `npm install --package-lock-only`.
2. Merge to `main`, then tag the merge commit: `git tag -a v0.35.14 -m "…"` and `git push origin v0.35.14`.
3. Publish the GitHub release for the tag (`gh release create v0.35.14 --latest --verify-tag --notes-file …`), with the intro, the five bullets, **What's new** and the install guide.
4. Publishing the release runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml): it checks that the tag matches `package.json`, runs the type check and tests, and publishes to npm with a provenance statement. Run it again by hand from the Actions tab (**Publish to npm → Run workflow**, with the tag) if it failed.

## npm setup (once)

The workflow uses npm trusted publishing: npm accepts publishes from this repository's workflow without any stored token.

1. The npm organization `coywolf` owns the `@coywolf` scope.
2. The first version is published by hand, because npm sets up a trusted publisher only for a package that exists. From a clean checkout of the release tag, signed in to npm with an account in the `coywolf` organization: `npm publish --access public` (npm asks for the two-factor code).
3. On npmjs.com, open `@coywolf/emdash` → **Settings** → **Trusted publishing**, choose **GitHub Actions**, and enter organization `coywolf-llc`, repository `coywolf-pack`, workflow `publish.yml` (no environment).
4. Optional, recommended: in the package's **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working.

Until step 2 is done, the workflow notes that the package isn't on npm yet and skips publishing.
