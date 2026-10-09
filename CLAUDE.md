# Working on ClaudeConnect

- **Never merge.** Push a branch and open its pull request, then stop: the owner reviews and merges every pull request by hand. Don't merge, don't enable auto-merge, and don't add anything (a workflow, a bot) that merges. If CI is red, fix it on the branch.
- Anything that ships (the files listed in `scripts/release.mjs`) needs a version bump and patch notes: `node scripts/release.mjs <version>`, edit `notes` in `manifest.json`, then `node scripts/release.mjs` again. CI fails otherwise.
- `npm test` and `npm run test:e2e` before pushing. CI runs once per pull request (unit tests, and the end-to-end tests in three parallel parts) and again on `main` after a merge.
