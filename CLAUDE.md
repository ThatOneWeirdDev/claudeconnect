# Working on ClaudeConnect

- **Always merge.** After pushing a branch and opening its pull request, merge it into `main` yourself as soon as CI is green. Don't wait to be asked, and don't leave it for the owner. If CI is red, fix it first; never merge red.
- Anything that ships (the files listed in `scripts/release.mjs`) needs a version bump and patch notes: `node scripts/release.mjs <version>`, edit `notes` in `manifest.json`, then `node scripts/release.mjs` again. CI fails otherwise.
- `npm test` and `npm run test:e2e` before pushing.
