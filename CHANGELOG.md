# Changelog

## 1.0.3 — 2026-11-05

- **Pug tells you about new versions:** copies installed from a `.vsix` look on GitHub once a day and offer
  **Install update** (downloads it, installs it, offers a reload). New command **PushPug: Check for Updates**,
  setting `pushpug.updates.check`. Marketplace copies are left to VS Code
- PushPug Settings → GitHub: choose how commits on main reach the team (ask / straight to main / always a pull request)
- Fix: uncommitted work could be lost — after an autostash conflict thrown away with `git reset --hard`, the stash
  holding that work was dropped. It's now kept unless the work is really still in the working copy
- Fix: a cherry-pick or revert conflict was mistaken for an autostash conflict when an old autostash was left over
- Fix: a clone of an empty repo never noticed the teammate's first push
- Fix: two GitHub checks with the same name in different workflows were merged, which could hide a failure
- Fix: Start New Task failed when a branch called `task` existed; a free name is now found
- Fix: Push (check first) failed when the local branch name differed from its upstream
- Fix: "403" anywhere in an error (e.g. a repo URL) was reported as a sign-in problem
- Fix: Undo merge vanished in repos with tens of thousands of untracked files, and after a second pull that was up to date
- Fix: pull request notices (merged, closed, conflicts, teammate opened one) were lost for good during quiet hours
- Fix: Windows toasts — a curly quote in a commit subject or name could break out of PowerShell and run code;
  data now goes in as base64
- Fix: `vscode://` links only act on repos PushPug already watches, and paths with `+` or `&` work
- Fix: Windows background task with a non-English (e.g. Thai) user name never ran
- Fix: the macOS background job's `launchd.log` grew forever; it's gone
- Fix: a background alert stayed on screen after you pulled while VS Code was closed
- Fix: an alert whose text started with "-" was dropped by alerter
- "Send for review" is hidden from the Source Control bar when you push straight to main
- My Team fits a narrow side bar (e.g. a MacBook with the side bar dragged to its minimum): smaller Pug and padding, commit
  badges move under the text, author and time no longer break one letter per line, buttons and file names don't get cut off
- Pick how your commits on main reach the team with `pushpug.pullRequests.workflow`: **ask** (new default: My Team offers both
  **Push to main** and **Send as pull request**), **direct** (push straight to main, no pull request reminders) or **pullRequest**
  (the old behaviour). It's a personal setting, so one teammate can push to main while another always uses pull requests

## 1.0.2 — 2026-10-23

- Pressing **Finish merge** on the "all conflicts fixed" pop-up could hang PushPug for that repository (it waited for itself); checks now run their follow-ups after releasing the repository
- A push refused by another GitHub rule (e.g. push protection finding a secret) is no longer mistaken for "this branch only accepts pull requests"; it gets its own explanation
- My Team cards no longer jump or fade in again on every check (they're only redrawn when something changed)
- Activity Bar icon is now a paw print (clearer at small sizes than the pug head)
- Pull requests: **Start New Task** makes a branch from the latest main (uncommitted work comes along);
  **Send for Review** pushes it and opens the pull request on GitHub (or sends new commits to the open one).
  Commits made on main by mistake are moved to a task branch, and main is put back in line with the remote.
  PushPug tells you when your pull request is merged (**Back to main**: switch, pull, delete the finished branch),
  closed, or conflicts with main (**Get the latest main**), and when a teammate opens one. A card in My Team shows
  the task and its pull request. A push refused by branch protection / rulesets is explained, with
  **Send for review instead**. Settings `pullRequests.enabled`, `pullRequests.notifyTeam`
- Renamed to PushPug (was PushPal); the mascot is now called Pug. The old background job is removed on first run;
  settings saved under `pushpal.*` need to be set again
- GitHub checks: after your pushes and your teammates', PushPug follows the commit's check runs and statuses
  and tells you how it went ("✅ All checks passed (4/4)" / "❌ Checks failed: 1 of 4 — Test (ubuntu-latest)").
  A teammate's failing push says "maybe don't pull it yet" (See what broke / Pull anyway / Later); you're told
  when it's fixed. Status bar ✓ / ✗ / ⏳; a badge on every commit in My Team that opens the list of checks,
  and for a failing GitHub Actions job the failed step, the last 30 log lines and a plain-language hint.
  Uses VS Code's GitHub sign-in (asked once); background alerts include checks when the `gh` CLI is signed in.
  New wizard step and settings (`actions.notifyOnPass`, `actions.notifyFor`)
- Push (check first): fetches before pushing and offers "Merge, then push for me"; rejected pushes from VS Code's
  own Push / Sync are explained with the same offer
- Undo the last merge for 10 minutes, uncommitted work included (refuses, with a reason, after new commits or edits)
- Git errors explained in plain language with the fix, plus "Show full message"
- Do-not-disturb hours and "Mute 1 hour" (status bar keeps updating; missed alerts come afterwards)
- README rewritten (English) with install steps for macOS and Windows and a how-to section
- My Team timeline shows commit authors' GitHub profile pictures (initials when there's none); setting `pushpug.avatars`
- New mascot: Pal is a flat-style pug head whose expressions follow what's going on — asleep when you're up
  to date, sniffing while checking, startled and barking when a teammate pushes, tugging a two-colour rope
  while merging, jump-spinning on success, puzzled at conflicts, teary when GitHub Actions fail, winking when
  they pass, wiggling when you poke it (heart eyes after a few pokes). Random idle life (blinks, ear twitches, glances, little smiles).
  Animated with GSAP; respects reduced motion
- New extension icon and Activity Bar icon (pug head)
- Check frequency modes: ⚡ Fastest (10 s), ⚖️ Balanced (30 s, new default), 🔋 Battery saver (60 s) and 🛠 Custom,
  in the setup wizard (new step) and the settings page, each with checks/hour and data/hour estimates from measured fetch sizes
- Automatic battery saving: idle, low battery (not plugged in), Low Power Mode / Battery Saver, plugged in = normal;
  the status bar tooltip explains when and why checks are slower
- Checking hours (e.g. 08:00–23:00), honoured by the background job too
- Separate background interval (60–3600 s); the background job re-reads its settings on every run
- GitHub Actions watcher: status bar progress while tests run, a message when they pass or fail
- New “PushPug Settings” page (Notifications / Frequency & battery / Language & theme / GitHub), live two-way sync with
  VS Code Settings, Restore defaults; new command “PushPug: Switch Check Mode”
- Values outside their range are pulled back in and you're told what changed
- `pushpug.checkIntervalSeconds` now allows 10–300 s (default 30). An explicit value from 1.0.0 is kept and the mode becomes Custom
- New mascot: Pal is now a round face whose brows, eyes, mouth and cheeks change with the state
- Poke Pal: it squishes, bounces and giggles, and gets dizzy if you poke too fast
- Activity bar icon matches the new face
- Releases: `npm run release` bumps the version and pushes a tag; CI publishes to the Marketplace and Open VSX
- Fix: background-worker test no longer expects launchctl/schtasks on Linux

## 1.0.0 — 2026-10-22

First release.

- Checks the remote every 60 s and whenever VS Code regains focus; one alert per new commit
- Same-file warning (uncommitted, committed-but-unpushed and new files)
- One-click “Pull in changes” (`git pull --no-rebase --autostash --no-edit`) that never loses uncommitted work
- Conflict guide: merge vs. autostash conflicts, Merge Editor, “Finish merge”, automatic autostash cleanup
- Status bar with four states; multi-repo workspaces; branches without upstream
- Desktop notifications on macOS (alerter / osascript), Windows (toast) and Linux (notify-send)
- Optional background checks while VS Code is closed (LaunchAgent / Task Scheduler), self-removing on uninstall
- Setup wizard, “My Team” view with timeline and mascot animations
- Thai and English; Light, Dark and Match-VS-Code themes
