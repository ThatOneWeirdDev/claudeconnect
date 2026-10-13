# ClaudeConnect

Use Claude Code from any browser. ClaudeConnect puts a chat site on your own Cloudflare account, closed to everyone except you by Cloudflare Access, and a small program on your computer that does the actual work with your Claude plan.

You need Node.js 22 or newer, a Cloudflare account (the free plan is enough), and either a paid Claude plan (Pro, Max, Team or Enterprise), which runs Claude Code, or a free Claude account and the [Claude app](https://claude.ai/download): see [Without a paid plan](#without-a-paid-plan).

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

Setup asks for a name and whether you pay for Claude, signs you in to Cloudflare, creates the site, then walks you through turning on Cloudflare Access and opening a one-time claim link. Running it again on a computer that is already set up offers **update** (in place, no questions), **reset** or **leave it**.

## From a terminal

| Command | What it does |
| --- | --- |
| `<command> update` | Updates the site and this computer to the newest version, in place. Your chats, name, look and settings are kept. If the new version brings a setting of its own, it asks about that, and nothing else. |
| `<command> edit` | Goes through every setting the site's **Settings** has, in the same order, each with what it is now and a y/n: the name, logo, tab icon and theme; starting when you log in, your Claude plan, and the working folder; whether the site uses usage credits (on a paid plan); and the address. Then it shows what will change and asks once more before saving. Last it asks whether to delete the site, which needs you to type its name. |
| `<command> help` | Lists the rest: start, stop, logs, status, open, claim and so on. |

## Everything from the site

Open your site, click your account at the bottom of the sidebar, and choose **Settings**. There's no Save button: a switch, a new logo or a name (when you press Enter or click away) takes effect straight away, on every device, with no redeploy. The site tells your computer too, so its own copy matches for the next update and for `<command> edit`; a change made later with `<command> edit` wins.

| Settings page | What it does |
| --- | --- |
| **General** | The site's name. Under **This computer**: **Start when you log in**, which makes it a startup item (a Login Item on macOS, the Startup folder on Windows) so it's online whenever you are; **Your Claude plan**, paid (Claude Code answers) or free (the Claude app answers); and the folder Claude Code works in. |
| **Appearance** | The logo and the tab icon (PNG, JPEG, GIF, WebP, ICO or SVG, up to 512 KB), and light, dark or system theme. The theme is kept on the site, so it's the same on every device. |
| **Address** | The name in the `workers.dev` address. A new address is a new Worker, so the **new site is created first** and this one keeps working. The page shows how to turn on Cloudflare Access for the new address and gives you its claim link. Once the new site is claimed and your computer has connected to it, the **old site is deleted** and you get the new link. Chats stay with the old site, so they go with it. You can cancel at any point before then and nothing changes. |
| **Updates** | Shows when a new version is out and installs it in place. |
| **Delete site** | Deletes the site and every chat in it, then removes the setup from your computer. The folder Claude works in is kept. You type the site's name to confirm. |

Nothing destructive happens before its replacement works: a move only deletes the old site after the new one is claimed and your computer is connected to it, and a failed step puts everything back.

The command you run on your computer (`<command> help` lists them) doesn't change when you rename the site.

### Under the message box

| Control | What it does |
| --- | --- |
| **+** | Add files. |
| **Auto** / **Ask first** / **Accept edits** / **Plan** | How freely Claude Code acts. Every message runs as Claude Code, working in the folder on your computer with its own default instructions. **Auto** lets it decide what is safe. **Ask first** asks you before anything that needs permission: a command, an edit, a folder outside the working folder. **Accept edits** edits files without asking. **Plan** looks around and writes a plan, and asks before carrying it out. Whenever Claude Code asks, in any of these, the page dims and shows just that question, and **Allow** or **Deny** on any device goes straight back to Claude Code. A question nobody answers in 10 minutes is a no. |
| **Model** and **Effort** | Show what is picked and open a list to change it. Haiku has no effort setting, so its button is hidden. Fable 5.1 is listed when you have usage credits to spend (see below). |
| **Ring** | How much of the model's context window the chat has used, from the last reply. It shows once a chat has started, not in an empty message box. When it gets full the conversation is compacted automatically. |

On the free plan the model list is the Claude app's own, and there's an **Extended thinking** switch instead of effort and permission modes.

Asking on the site needs a Claude Code that can ask through another program (`--permission-prompt-tool`) and the program on your computer at 2.0.0 or newer. Without that, anything that would need permission is skipped and **Ask first** isn't offered. Updating from the site brings it up to date.

### Plan usage

**Plan usage** in the account menu shows how much of your Claude plan you've used: the current 5-hour session and the weekly limit, as percentages, with when each resets. These are the real numbers from your Claude account, not an estimate. Claude Code reads them from Anthropic's responses to every reply and reports them to ClaudeConnect. Each time you open Plan usage it reads the latest by itself, with one tiny message to the cheapest model (at most every 20 seconds).

It also shows your **usage credits** (claude.ai's "extra usage"): whether they're on, in use because you're past a plan limit, close to the spending limit you set, used up, or off (and why, when Claude says). Past a plan limit with credits on, replies carry on, so the page says you're using credits rather than that you've hit a limit. "You've hit a limit" only shows when replies really have stopped, and only until the limit resets.

**Limit resets** on your Claude account (Anthropic gives resets you can use whenever you choose, including free daily or weekly ones) are listed there too, with how many are left, what each clears and how often a new one comes, and **Use one** uses one, the same way Claude's own reset does. When you're out of usage, the note that says so also says when the limit resets, and offers **Use a free reset** when you have one. It's done by your computer with Claude's own sign-in there, like the balance below.

**Use usage credits from this site** is a switch on the same page (and in `<command> edit`), kept on the site so it applies on every device. Turned off, the site holds new messages while you're at a plan limit, so they don't use credits, and Fable 5.1 (which runs on credits) is paused. A reply already under way can still go past the limit; that part is Claude's.

**Fable 5.1 is in the model picker whenever you have usage credits to spend**, marked **Uses usage credits**, because it only runs on them. When Claude Code or your balance says you have none (used up, not turned on for your Claude account, a balance of nothing, or usage credits turned off for this site), it isn't listed, and a message to it from a page that still shows it isn't sent: you're told you have no usage credits. Your computer reads the plan and the balance again straight away, so after topping up on claude.ai it's back.

**Your balance, promotional credits (including the free Claude Code cloud credits, with what's left and when they run out) and this month's spending** show on the same page too. That needs your Claude account, and claude.ai doesn't let other sites in, so it's done by the program on your computer with Claude Code's own sign-in, the same way Claude Code's `/usage` asks. They're always shown; there's no setting for it. The sign-in is read on your computer and sent only to Anthropic; the site only ever gets the numbers. It's read each time you open Plan usage. These come from parts of Claude's API that Claude Code uses but Anthropic hasn't published, so a future change on their side could make them disappear; the page then says it couldn't read them, and they're always on claude.ai.

Plans billed per token (an API key) don't report these, so nothing is shown. Claude Code marks this field as internal, so a future version could change it; if it disappears, the page just shows nothing.

### If the site is locked

A site that isn't behind Cloudflare Access is closed to **everyone**, including you. The locked page has an **I'm the owner** button that shows what to do: in the Cloudflare dashboard open your Worker, then **Settings** → **Domains & Routes** → **workers.dev** → **Enable Cloudflare Access**, and allow only your own email. A visitor from any other account can sign in to Access and still not get in: the site stays closed unless the sign-in is the one that claimed it.

Lost your claim link, or turned Access off and on again? Run `<command> claim` on your computer for a fresh one. It works because that computer holds your Cloudflare sign-in.

## Your chats are Claude Code's chats

Every chat here is a normal Claude Code conversation, saved on your computer in Claude Code's own folder (`~/.claude/projects`). So the site and Claude Code share one history:

- **Chats you started in the terminal or the desktop app are in the sidebar**, with the ones you started here. A chat from another project shows that project's folder name under its title.
- **Open any of them** and its conversation is copied to the site, then kept in step: whatever you add in the terminal later shows up the next time you open it.
- **Carry on from the site.** It resumes the same conversation, in the folder it began in, so Claude Code sees the same project and the same history. You can pick it up again in the terminal afterwards with `claude --resume`.
- **Delete** on the site only hides a chat from the site (so it doesn't reappear). Nothing is deleted on your computer.

Only a list (titles and the last part of each folder's name) goes to the site until you open a chat; then that chat's text is copied. Very long chats bring the latest part (up to 300 turns and about 3.5 MB), and the rest stays on your computer. Chats from claude.ai in the browser aren't stored on your computer, so they aren't on the site.

The sidebar lists every Claude Code chat on this computer, up to 3,000. It can only list what Claude Code still has: Claude Code deletes chats it hasn't touched for 30 days unless you raise `cleanupPeriodDays` in `~/.claude/settings.json` (to keep them all, set it to a large number such as `36500`). A chat you've opened on the site stays on the site even after Claude Code has deleted its copy.

On the free plan there's no Claude Code, so the sidebar has the chats started on the site. Each one is a conversation in the Claude app, on claude.ai.

## Without a paid plan

Claude Code needs a paid Claude plan. Without one, answer **no** when setup asks whether you pay for Claude (or switch later in **Settings** → **General** → **This computer**, or with `<command> edit`), and the [Claude app](https://claude.ai/download) answers instead:

- **Your message is typed into the Claude app** on your computer, with the model you picked on the site and extended thinking on or off, and sent. The reply is read from the app as it's written and streams to the site.
- **The model picker lists the app's own models.** Ones that need a paid plan are shown but can't be picked. **The app's choice** leaves the app on whatever it has picked.
- **A chat on the site stays one conversation in the app**, so a follow-up carries on where it left off. **Stop** stops the reply in the app too.
- **Files you attach** are added to the message in the app. If the app won't take them, text files go into the message itself.
- **Plan usage** shows the free plan's limits from claude.ai, when each resets, and your free limit resets, daily or weekly, with a button to use one. Running out says until when.
- **When the app asks something**, such as a permission window, the page dims and shows a picture of just that window. Click it, or one of its buttons, on any device and the click happens in the app. Nobody answering for 10 minutes closes it, which allows nothing, and stops the reply.

How it works: the program on your computer starts the Claude app with Chromium's debugging connection on, on a port only your computer can reach, and works with the page through it, the way a browser's developer tools do. It finds the message box, the model menu and the send button by what they are rather than where they are on the screen, so the window can be any size, behind other windows or on another desktop. It doesn't move your mouse or use your keyboard or clipboard, so you can keep using the computer while it types. If the app is already open without that connection, it's restarted once; your conversations are on claude.ai, so nothing is lost. Messages go one at a time, since there's one app window; a second one waits and says so.

No Claude app on this computer (there's none for Linux), or it won't open the connection? ClaudeConnect opens claude.ai in a window of its own in Chrome, Edge, Brave, Vivaldi or Chromium instead, with a profile of its own. Sign in to Claude there once. It's an ordinary browser window you sign in to yourself, started without the switches automation tools use, so claude.ai sees an ordinary browser and there's no "are you a robot" check beyond the one you'd get anyway.

This depends on how claude.ai's page is built. If Anthropic changes it in a way ClaudeConnect doesn't follow, the site says it couldn't type into the app or read the reply, and an update fixes it. Paths can be set with `CLAUDECONNECT_CLAUDE_APP` and `CLAUDECONNECT_BROWSER` if yours are somewhere unusual.

## Updating

The site checks this repository for a newer version every minute (skipping GitHub's own five-minute cache) and shows **Update available**. Click it for the patch notes, then **Update now**: your computer downloads the release, checks every file against the manifest, redeploys the site in place and restarts. When the steps are done the page switches to the new version by itself, as soon as nothing you were typing, attaching or waiting for could be lost (**Reload now** is there if you'd rather not wait). It's the same address, so there's no new link. Once a page has loaded the new version, **Updated** and **Reload** are gone, on every device, until the next update (the same goes for a change in Settings). If Cloudflare still hands out the old page for a moment after you reload, the page quietly tries again rather than asking you to. You can also run `<command> update` in a terminal.

The update screen can always be closed: the update carries on by itself, and the button in the top bar shows how far it's got and opens it again. When a new version brings a setting of its own, the update screen asks about it before you press **Update now**, and the answer is set as soon as the new version is running. The **Updates** panel in Settings keeps the patch notes: the first time each browser opens a new version it opens on them, and **Earlier updates** lists the last few.

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
# a new computer setting the update should ask about goes in "questions":
#   { "key": "autostart", "label": "…?", "help": "…", "default": true, "since": "1.9.0" }   (keys: autostart)
node scripts/release.mjs         # refresh the hashes after editing
```

Once it's on `main`, every open site offers the update within about a minute and a half (or straight away with **Check again**). CI fails if the hashes are stale, and on pull requests it fails if shipped files changed without a new version.

A site is deployed before the program on your computer is replaced, so a new site has to keep working with the previous agent.

## Layout

| Path | What it is |
| --- | --- |
| `install.sh`, `install.ps1` | One-line installs. They check for Node, download the launcher and run it. |
| `ClaudeConnect.mjs` | Launcher: downloads, verifies, runs the installer. A copy is kept on your computer for updates. |
| `installer.mjs` | Setup wizard, plus the no-questions operations the site's Settings use: `--remote-update`, and `--remote-op settings`, `move` or `delete`. |
| `agent/agent.mjs` | The program on your computer that runs Claude Code and carries out what the site asks. |
| `agent/sessions.mjs` | Reads Claude Code's saved chats, for the list and for opening them. |
| `agent/app.mjs` | The free plan: opens the Claude app (or a browser window) over the debugging connection, types each message and reads the reply. |
| `agent/permit.mjs` | The small MCP server Claude Code asks through for **Ask first**, which passes each question to the site. |
| `site/worker.js` | The Cloudflare Worker and its Durable Object: chats, the locked page, plan usage, and the checklist for whatever is running. |
| `site/app.html` | The web app. Its colours and type follow OpenAI's published ChatGPT design tokens. |
| `site/names.js`, `site/image.js`, `site/version.js` | Shared checks for names, addresses, images and versions, kept separate so the site and the installer use the same rules and they can be tested. |
| `manifest.json` | Version, release notes, file checksums. |
| `scripts/release.mjs` | Keeps the manifest honest. |
| `.github/workflows` | CI on every pull request and on `main`, and the auto-merge that follows a green run. |

## Development

```sh
npm install
npm test            # manifest check and unit tests
npm run test:e2e    # the real worker in workerd (miniflare), and full runs with real processes
```

The end-to-end tests run the unmodified worker with real Access-JWT verification against a throwaway key. The free plan's run in a real headless Chromium against a stand-in for claude.ai (skipped when there's no Chromium). The heavier ones run the real agent, launcher and installer together on a temporary home folder, with only `claude`, `wrangler` and Cloudflare's API replaced by fakes, and drive a complete update, a settings change, a move (including the old site being deleted only after the new one is claimed, and a cancel that rolls everything back) and a delete.

### Pull requests merge themselves

CI runs on every pull request. When the unit and end-to-end tests pass on its newest commit, the **Auto-merge** workflow squash-merges it, if the repository's owner or Claude opened it, it isn't a draft, and it comes from a branch of this repository. Nothing red is merged, and neither is anything pushed after the tests started.

GitHub doesn't let its own Actions token merge a pull request that changes the files in `.github/workflows`. To have those merge by themselves too, add a personal access token with the `repo` and `workflow` scopes as a repository secret named `AUTO_MERGE_TOKEN`. Without it, such a pull request gets a comment saying so, and you merge it yourself.
