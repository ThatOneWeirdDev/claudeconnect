# ClaudeConnect

Use Claude Code from any browser. ClaudeConnect puts a chat site on your own Cloudflare account, locked to you with Cloudflare Access, and a small program on your computer that does the actual work with your Claude plan.

## Install

You need Node.js 22 or newer and a free Cloudflare account.

```sh
curl -fsSL https://raw.githubusercontent.com/ThatOneWeirdDev/claudeconnect/main/ClaudeConnect.mjs -o ClaudeConnect.mjs
node ClaudeConnect.mjs
```

On Windows (PowerShell):

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/ThatOneWeirdDev/claudeconnect/main/ClaudeConnect.mjs -OutFile ClaudeConnect.mjs
node ClaudeConnect.mjs
```

`ClaudeConnect.mjs` is only a launcher. It downloads the current release from this repository, checks every file against [`manifest.json`](manifest.json), and runs the setup that came with it. Nothing about ClaudeConnect itself is stored inside that file.

Setup walks you through naming the site, signing in to Cloudflare, turning on Cloudflare Access and opening the one-time claim link. Running it again on a computer that is already set up offers **update**, **reset** or **leave it**.

## Usage

The chart icon at the top right opens **Usage**: tokens, replies and estimated cost, by day (last 30 days) or by week (last 12), in your time zone. Hover, tap or use the arrow keys to read a day, or switch to the table view.

- **Tokens** are what Claude read in and wrote out. Chat history it re-read from its cache is shown separately and isn't counted.
- **Est. cost** is calculated at API prices. It is not what your Claude plan charges.
- Token and cost figures start from the day you installed this version. Replies go back as far as your chats do.

## Updating

The site checks this repository for a newer version every half hour. When there is one, an **Update available** button appears at the top. Click it to see what's new and start the update from the page:

1. Your computer downloads the release and checks every file against the manifest.
2. It redeploys the site **in place**. The site is never deleted, so it stays up and your chats are kept.
3. It updates and restarts the program on your computer.
4. The page ends with a link to the updated site.

The site keeps the progress, so you can watch from any device and come back to it after the restarts. If a step fails, the page says which one and why, nothing on your computer is changed unless the site step succeeded, and **Try again** is one click.

You can also update from a terminal with `<your command> update` (the command is the site's name, shown by `<your command> help`).

**First time only:** versions before 1.2.0 can't update from the page, because the program on your computer doesn't know how yet. Download the new `ClaudeConnect.mjs` as above, run it and choose **update**. From then on the button works.

### Where updates come from

By default `main` of this repository. The choice is saved at install and used for every later update:

```sh
node ClaudeConnect.mjs --ref v1.2.0                 # a tag or commit, so nothing changes until you decide
node ClaudeConnect.mjs --repo yourname/claudeconnect # your own fork
```

An update runs code from that source on your computer and in your Cloudflare account, so treat the repository you point it at like any other software you install. The checksums protect against a corrupted or half-updated download. They don't protect against a source you shouldn't trust.

## Making a release

`manifest.json` holds the version and a SHA-256 for every file that ships. The site, the launcher and the installer all trust it, so keep it in step with the files:

```sh
node scripts/release.mjs 1.3.0   # sets the version in manifest.json and package.json, refreshes the hashes
# edit "notes" in manifest.json: these lines are what people see under "What's new"
node scripts/release.mjs         # refresh the hashes after editing
```

Merge to `main` and every site offers the update within half an hour (or straight away with **Check again**). CI fails if the hashes are stale, and on pull requests it fails if shipped files changed without a new version.

A site is deployed before the program on your computer is replaced, so a new site has to keep working with the previous agent.

## Layout

| Path | What it is |
| --- | --- |
| `ClaudeConnect.mjs` | Launcher: downloads, verifies, runs the installer. A copy is kept on your computer for updates. |
| `installer.mjs` | Setup wizard, and the no-questions `--remote-update` the site's Update button uses. |
| `agent/agent.mjs` | The program on your computer that runs Claude Code. |
| `site/worker.js` | The Cloudflare Worker and its Durable Object (chats, usage, update state). |
| `site/app.html` | The web app. |
| `site/usage.js`, `site/version.js` | Usage bucketing and version checks, kept separate so they can be tested. |
| `manifest.json` | Version, release notes, file checksums. |
| `scripts/release.mjs` | Keeps the manifest honest. |

## Development

```sh
npm install
npm test            # manifest check and unit tests
npm run test:e2e    # the real worker in workerd (miniflare), plus a full update with real processes
```

The end-to-end tests run the unmodified worker with real Access-JWT verification against a throwaway key. One of them runs the real agent, launcher and installer together on a temporary home folder, with only `claude` and `wrangler` replaced by fakes, and drives a complete update from the site's API.
