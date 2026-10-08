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
| **General** | The site's name, and whether Fable 5.1 shows in the model picker. The site is redeployed in place, so **your chats are kept**. |
| **Appearance** | The logo and the tab icon (PNG, JPEG, GIF, WebP, ICO or SVG, up to 512 KB), and light, dark or system theme. Same in-place redeploy. |
| **Address** | The name in the `workers.dev` address. A new address is a new Worker, so the **new site is created first** and this one keeps working. The page shows how to turn on Cloudflare Access for the new address and gives you its claim link. Once the new site is claimed and your computer has connected to it, the **old site is deleted** and you get the new link. Chats stay with the old site, so they go with it. You can cancel at any point before then and nothing changes. |
| **Updates** | Shows when a new version is out and installs it in place. |
| **Delete site** | Deletes the site and every chat in it, then removes the setup from your computer. The folder Claude works in is kept. You type the site's name to confirm. |

Nothing destructive happens before its replacement works: a move only deletes the old site after the new one is claimed and your computer is connected to it, and a failed step puts everything back.

The command you run on your computer (`<command> help` lists them) doesn't change when you rename the site.

### Under the message box

| Control | What it does |
| --- | --- |
| **+** | Add files. |
| **Claude** / **Claude Code** | **Claude** is plain chat: no tools, no folder, nothing on your computer is touched. **Claude Code** is the real thing, working in the folder on your computer with its own default instructions. You can switch in the middle of a chat; the next reply reads the whole conversation again, and the page says so. |
| **Auto** / **Accept edits** / **Plan** | How freely Claude Code acts (Claude Code only). **Auto** lets it decide what is safe. **Accept edits** edits files without asking and skips anything else that would need approval. **Plan** looks around and writes a plan without changing anything. Nobody can be asked mid-reply from a web page, so there is no "ask me each time". |
| **Model** and **Effort** | Show what is picked and open a list to change it. Haiku has no effort setting, so its button is hidden. |
| **Ring** | How much of the model's context window the chat has used, from the last reply. When it gets full the conversation is compacted automatically. |

These need the program on your computer to be 1.4.0 or newer. On an older one the page hides the Claude / Claude Code switch and the permission mode and everything runs as Claude Code; updating from the site brings it up to date.

### Plan usage

**Plan usage** in the account menu shows how much of your Claude plan you've used: the current 5-hour session and the weekly limit, as percentages, with when each resets. These are the real numbers from your Claude account, not an estimate. Claude Code reads them from Anthropic's responses to every reply and reports them to ClaudeConnect, so they're as fresh as your last message. **Refresh** sends one tiny message to the cheapest model to read the latest.

Plans billed per token (an API key) don't report these, so nothing is shown. Claude Code marks this field as internal, so a future version could change it; if it disappears, the page just shows nothing.

### If the site is locked

A site that isn't behind Cloudflare Access is closed to **everyone**, including you. The locked page has an **I'm the owner** button that shows what to do: in the Cloudflare dashboard open your Worker, then **Settings** → **Domains & Routes** → **workers.dev** → **Enable Cloudflare Access**, and allow only your own email. A visitor from any other account can sign in to Access and still not get in: the site stays closed unless the sign-in is the one that claimed it.

Lost your claim link, or turned Access off and on again? Run `<command> claim` on your computer for a fresh one. It works because that computer holds your Cloudflare sign-in.

## Your chats are Claude Code's chats

Every chat here, in **Claude** or **Claude Code**, is a normal Claude Code conversation, saved on your computer in Claude Code's own folder (`~/.claude/projects`). So the site and Claude Code share one history:

- **Chats you started in the terminal or the desktop app are in the sidebar**, with the ones you started here. A chat from another project shows that project's folder name under its title.
- **Open any of them** and its conversation is copied to the site, then kept in step: whatever you add in the terminal later shows up the next time you open it.
- **Carry on from the site.** It resumes the same conversation, in the folder it began in, so Claude Code sees the same project and the same history. You can pick it up again in the terminal afterwards with `claude --resume`.
- **Delete** on the site only hides a chat from the site (so it doesn't reappear). Nothing is deleted on your computer.

Only a list (titles and the last part of each folder's name) goes to the site until you open a chat; then that chat's text is copied. Very long chats bring the latest part (up to 300 turns and about 3.5 MB), and the rest stays on your computer. Chats from claude.ai in the browser aren't stored on your computer, so they can't be shown here.

The sidebar lists up to 3,000 chats. It can only list what Claude Code still has: Claude Code deletes chats it hasn't touched for 30 days unless you raise `cleanupPeriodDays` in `~/.claude/settings.json` (to keep them all, set it to a large number such as `36500`). A chat you've opened on the site stays on the site even after Claude Code has deleted its copy.

If you'd rather share less, set `history` in `config.json` in the ClaudeConnect folder on your computer (`~/.claudeconnect`) and restart `<command>`:

| `history` | What the site can list and open |
| --- | --- |
| `"all"` (the default) | Every Claude Code chat on this computer. |
| `"workspace"` | Only chats started in the working folder. |
| `"off"` | None. Chats started on the site still work. |

This needs the program on your computer to be 1.5.0 or newer. Updating from the site brings it up to date.

## Updating

The site checks this repository for a newer version every minute (skipping GitHub's own five-minute cache) and shows **Update available**. Click it for the patch notes, then **Update now**: your computer downloads the release, checks every file against the manifest, redeploys the site in place and restarts. When the steps are done the page switches to the new version by itself, as soon as nothing you were typing, attaching or waiting for could be lost (**Reload now** is there if you'd rather not wait). It's the same address, so there's no new link. You can also run `<command> update` in a terminal.

The **Updates** panel in Settings keeps the patch notes: what an update brings is shown while it installs and when it's done, the first time each browser opens the new version it opens on them, and **Earlier updates** lists the last few.

**First time only:** versions before 1.3.0 can't do any of this from the page, because the program on your computer doesn't know how yet. Run the install command above once and choose **update**.

### Where updates come from

By default `main` of this repository, saved at install and used for every later update:

```sh
node ClaudeConnect.mjs --ref v1.5.0                  # a tag or commit, so nothing changes until you decide
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

Merge to `main` and every open site offers the update within about a minute and a half (or straight away with **Check again**). CI fails if the hashes are stale, and on pull requests it fails if shipped files changed without a new version.

A site is deployed before the program on your computer is replaced, so a new site has to keep working with the previous agent.

## Layout

| Path | What it is |
| --- | --- |
| `install.sh`, `install.ps1` | One-line installs. They check for Node, download the launcher and run it. |
| `ClaudeConnect.mjs` | Launcher: downloads, verifies, runs the installer. A copy is kept on your computer for updates. |
| `installer.mjs` | Setup wizard, plus the no-questions operations the site's Settings use: `--remote-update`, and `--remote-op settings`, `move` or `delete`. |
| `agent/agent.mjs` | The program on your computer that runs Claude Code and carries out what the site asks. |
| `agent/sessions.mjs` | Reads Claude Code's saved chats, for the list and for opening them. |
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
