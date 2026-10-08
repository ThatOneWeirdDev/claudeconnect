# ClaudeConnect

Use Claude Code from any browser. ClaudeConnect puts a chat site on your own Cloudflare account, closed to everyone except you by Cloudflare Access, and a small program on your computer that does the actual work with your Claude plan.

You need Node.js 22 or newer, a Cloudflare account (the free plan is enough) and a Claude plan.

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/ThatOneWeirdDev/claudeconnect/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/ThatOneWeirdDev/claudeconnect/main/install.ps1 | iex
```

Or with npm, no download step:

```sh
npx github:ThatOneWeirdDev/claudeconnect
```

Each of these runs `ClaudeConnect.mjs`, a small launcher. It downloads the current release from this repository, checks every file against [`manifest.json`](manifest.json), and runs the setup that came with it. Nothing about ClaudeConnect itself is stored inside the launcher.

Setup asks for a name, signs you in to Cloudflare, creates the site, then walks you through turning on Cloudflare Access and opening a one-time claim link. Running it again on a computer that is already set up offers **update**, **reset** or **leave it**.

## Everything from the site

Open your site, click your account at the bottom of the sidebar, and choose **Settings**. Whatever you change here, your computer carries out and the page follows along step by step, from any device.

| Settings page | What it does |
| --- | --- |
| **General** | The site's name, what the AI calls itself, and whether Fable 5.1 shows in the model picker. The site is redeployed in place, so **your chats are kept**. |
| **Appearance** | The logo and the tab icon (PNG, JPEG, GIF, WebP, ICO or SVG, up to 512 KB), and light, dark or system theme. Same in-place redeploy. |
| **Address** | The name in the `workers.dev` address. A new address is a new Worker, so the **new site is created first** and this one keeps working. The page shows how to turn on Cloudflare Access for the new address and gives you its claim link. Once the new site is claimed and your computer has connected to it, the **old site is deleted** and you get the new link. Chats stay with the old site, so they go with it. You can cancel at any point before then and nothing changes. |
| **Updates** | Shows when a new version is out and installs it in place. |
| **Delete site** | Deletes the site and every chat in it, then removes the setup from your computer. The folder Claude works in is kept. You type the site's name to confirm. |

Nothing destructive happens before its replacement works: a move only deletes the old site after the new one is claimed and your computer is connected to it, and a failed step puts everything back.

The command you run on your computer (`<command> help` lists them) doesn't change when you rename the site.

### Plan usage

**Plan usage** in the account menu shows how much of your Claude plan you've used: the current 5-hour session and the weekly limit, as percentages, with when each resets. These are the real numbers from your Claude account, not an estimate. Claude Code reads them from Anthropic's responses to every reply and reports them to ClaudeConnect, so they're as fresh as your last message. **Refresh** sends one tiny message to the cheapest model to read the latest.

Plans billed per token (an API key) don't report these, so nothing is shown. Claude Code marks this field as internal, so a future version could change it; if it disappears, the page just shows nothing.

### If the site is locked

A site that isn't behind Cloudflare Access is closed to **everyone**, including you. The locked page has an **I'm the owner** button that shows what to do: in the Cloudflare dashboard open your Worker, then **Settings** → **Domains & Routes** → **workers.dev** → **Enable Cloudflare Access**, and allow only your own email. A visitor from any other account can sign in to Access and still not get in: the site stays closed unless the sign-in is the one that claimed it.

Lost your claim link, or turned Access off and on again? Run `<command> claim` on your computer for a fresh one. It works because that computer holds your Cloudflare sign-in.

## Updating

The site checks this repository for a newer version every half hour and shows **Update available**. Click it for what's new, then **Update now**: your computer downloads the release, checks every file against the manifest, redeploys the site in place and restarts. You can also run `<command> update` in a terminal.

**First time only:** versions before 1.3.0 can't do any of this from the page, because the program on your computer doesn't know how yet. Run the install command above once and choose **update**.

### Where updates come from

By default `main` of this repository, saved at install and used for every later update:

```sh
node ClaudeConnect.mjs --ref v1.3.0                  # a tag or commit, so nothing changes until you decide
node ClaudeConnect.mjs --repo yourname/claudeconnect # your own fork
```

An update runs code from that source on your computer and in your Cloudflare account, so treat the repository you point it at like any other software you install. The checksums protect against a corrupted or half-updated download. They don't protect against a source you shouldn't trust.

## Making a release

`manifest.json` holds the version and a SHA-256 for every file that ships. The site, the launcher and the installer all trust it, so keep it in step with the files:

```sh
node scripts/release.mjs 1.4.0   # sets the version in manifest.json and package.json, refreshes the hashes
# edit "notes" in manifest.json: these lines are what people see under "What's new"
node scripts/release.mjs         # refresh the hashes after editing
```

Merge to `main` and every site offers the update within half an hour (or straight away with **Check again**). CI fails if the hashes are stale, and on pull requests it fails if shipped files changed without a new version.

A site is deployed before the program on your computer is replaced, so a new site has to keep working with the previous agent.

## Layout

| Path | What it is |
| --- | --- |
| `install.sh`, `install.ps1` | One-line installs. They check for Node, download the launcher and run it. |
| `ClaudeConnect.mjs` | Launcher: downloads, verifies, runs the installer. A copy is kept on your computer for updates. |
| `installer.mjs` | Setup wizard, plus the no-questions operations the site's Settings use: `--remote-update`, and `--remote-op settings`, `move` or `delete`. |
| `agent/agent.mjs` | The program on your computer that runs Claude Code and carries out what the site asks. |
| `site/worker.js` | The Cloudflare Worker and its Durable Object: chats, the locked page, plan usage, and the checklist for whatever is running. |
| `site/app.html` | The web app. Its colours and type follow OpenAI's published ChatGPT design tokens. |
| `site/names.js`, `site/image.js`, `site/version.js` | Shared checks for names, addresses, images and versions, kept separate so the site and the installer use the same rules and they can be tested. |
| `manifest.json` | Version, release notes, file checksums. |
| `scripts/release.mjs` | Keeps the manifest honest. |

## Development

```sh
npm install
npm test            # manifest check and unit tests
npm run test:e2e    # the real worker in workerd (miniflare), and full runs with real processes
```

The end-to-end tests run the unmodified worker with real Access-JWT verification against a throwaway key. The heavier ones run the real agent, launcher and installer together on a temporary home folder, with only `claude`, `wrangler` and Cloudflare's API replaced by fakes, and drive a complete update, a settings change, a move (including the old site being deleted only after the new one is claimed, and a cancel that rolls everything back) and a delete.
