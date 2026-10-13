# Working on ClaudeConnect

- **Push, open the pull request, and let it merge itself.** Don't merge by hand. Once CI is green, the Auto-merge workflow (`.github/workflows/auto-merge.yml`, run by CI after the tests) merges pull requests from the owner or from Claude. If CI is red, fix it on the branch; it never merges red. A pull request that changes the workflow files can only be merged by a token with the `workflow` scope: without the `AUTO_MERGE_TOKEN` secret it gets a comment saying so, and the owner merges that one.
- Anything that ships (the files listed in `scripts/release.mjs`) needs a version bump and patch notes: `node scripts/release.mjs <version>`, edit `notes` in `manifest.json`, then `node scripts/release.mjs` again. CI fails otherwise.
- Every push that changes those files gets a new version number, however small the change, and even while its pull request is still open: never push changed files under a version that's already been pushed. A small fix is a patch version (2.3.0 → 2.3.1), a new feature a minor one (2.3.0 → 2.4.0).
- Never use the browser's `alert()`, `confirm()` or `prompt()` in the page or the setup window: ask in the page's own dialog (`askConfirm` in `site/app.html`).
- `npm test` and `npm run test:e2e` before pushing. CI runs once per pull request (unit tests, and the end-to-end tests in three parallel parts) and again on `main` after a merge.
