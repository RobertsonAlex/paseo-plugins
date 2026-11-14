# agents-dash-list

Paseo plugin that adds an **Agents dash** entry to the app sidebar, next to "New workspace",
"History" and "Schedules". It lists every workspace on **every host you have configured** and the
agents inside it, on one screen, grouped by what needs your attention.

![Agents dash](./images/agents-dash-list.png)

## Groups

Workspaces are sorted into exactly one group, in this order, and within a group by last activity
(newest first):

| Group | Shown when |
| --- | --- |
| Waiting for you | An agent (or the workspace itself) is waiting for a question or permission to be answered. |
| Unread | An agent finished with new results you have not seen yet, or you marked the workspace unread from the dash. |
| In progress | An agent is currently working. |
| Failing | An agent errored, the pull request has a failing check, or a reviewer requested changes. |
| Approved | The pull request is approved by reviewers and nothing above applies. |
| Idle | Everything is done and read. |
| Merged or closed | The pull request was merged or closed. |

Only non-empty groups are shown. Each group is a bordered section with a bold heading; pressing
the heading folds the group shut or open. The checkbox at the left of the heading selects or
clears every workspace in the group (see [Selection and bulk actions](#selection-and-bulk-actions)).

## Hosts

Every host configured in Paseo is read at once and the workspaces are merged into a single feed,
so a group like "Waiting for you" holds whatever is waiting anywhere. Each row names its host on
the meta line, opens on that host when pressed, and is archived through that host's own
connection.

When more than one host is configured the header holds a **Host** picker listing them all with
workspace counts; disconnected hosts are listed as `name (offline)`. Pick any number of hosts to
narrow the feed. A host that is disconnected or fails to answer is reported in a notice above the
feed while the other hosts keep working; only when *none* of the selected hosts answers does the
whole screen turn into an error with a Retry.

On a Paseo older than 0.8 the app exposes no host list, and the dash shows the host it was opened
on exactly as before.

## Filters and search

The header holds a **Project** picker listing every project that has a workspace on a visible
host, and a **Label** picker listing every workspace label found on those workspaces, each with
workspace counts and labels in their catalog color. Pick any number of projects or labels to show
only workspaces in one of those projects that carry at least one of those labels. Labels are
matched case- and whitespace-insensitively, like the app's own label picker.

The **search box** above the filters narrows the feed further as you type. Every word has to
appear somewhere on the row: the workspace name, project, branch, host, labels, agent titles, or
the pull request title or number (`#42`). The search is not remembered between opens.

While anything narrows the feed the count in the header reads `12 of 61 workspaces`; "All" in a
picker clears that picker, and "Clear filters" on the empty screen clears every filter and the
search.

## Remembered settings

The host, project and label choices and the folded groups are remembered between opens and across
app restarts. They are stored per daemon by the plugin's server entry under
`$PASEO_HOME/plugin-data/agents-dash-list/settings.json`, so every client of that daemon opens the
dash the way it was left.

## Row anatomy

Each workspace is one row:

1. **Main line** — a selection checkbox, the project icon, the workspace name, the time of last
   activity, and (for the groups that have them) quick-action buttons.
2. **Meta line** — project name, branch, host, and, when the workspace has a pull request: its
   state, checks, and review decision. Workspace labels render last, as the same colored chips
   the built-in sidebar workspace list uses.
3. **Agents line** — a row of small pills, one per agent, each showing a shortened agent name and
   an icon for that agent's own activity (waiting, unread, working, failing, idle). Pills are
   sorted by activity, then by last activity.

Pressing the main line navigates to the workspace's first agent (or the workspace itself when it
has no agents); pressing an agent pill navigates straight to that agent. Pressing the pull request
item on the meta line opens it in the browser instead of navigating.

## Quick actions

Quick actions appear on the groups a glance can settle; the groups with live activity (Waiting,
In progress, Failing) are navigate-only:

- **Unread** — Archive.
- **Approved** — Archive.
- **Idle** — Mark as unread, Archive.
- **Merged or closed** — Archive.

Archiving a workspace that has uncommitted changes or unpushed commits asks for confirmation
first, listing what would be left behind.

## Selection and bulk actions

Every row has a checkbox, and every group heading has one that selects or clears the whole group
(it shows a dash when only some of the group is selected). Once anything is selected a bar
appears under the header with the count and these actions:

- **Add label** — a picker of every known label (the catalog plus the labels already on
  workspaces), with a search box that also creates a new label when the name is not known yet.
  Each row says how many of the selected workspaces already carry it (`on 2 of 5`); pressing it
  adds the label to the rest.
- **Remove label** — the labels the selected workspaces carry, with the same counts; pressing one
  removes it from every selected workspace that has it.
- **Archive** — always asks first: the dialog says how many workspaces go and lists the ones that
  still hold uncommitted changes or unpushed commits.
- **Clear** — empties the selection.

The label pickers stay open so several labels can be changed in a row. Changes are made one
workspace at a time through each workspace's own host, and a toast reports the outcome, naming
any workspace that failed. A new label is created in the catalog of the host its workspace lives
on, so labels created on a remote host get that host's color.

Only rows on screen are acted upon: a selected row that the filters or search hide stays
remembered but is left out of the count and every action. The selection is not remembered
between opens, and archived workspaces drop out of it.

## Unread marks

"Mark as unread" is a marker owned by this plugin, not by Paseo itself — the built-in sidebar has
no notion of it. The mark clears automatically the moment the workspace is opened from the dash,
or the moment the workspace produces newer activity than the mark (a finished run, a new pull
request check, and so on), whichever comes first. Marks are stored per daemon under
`$PASEO_HOME/plugin-data/agents-dash-list/unread.json` and pruned after 90 days, or when their
workspace no longer exists and the dash was able to list *every* host's whole workspace directory
(a directory too large to enumerate, or a host that did not answer, is never treated as a census,
so no mark is dropped by mistake). The store is the one belonging to the host the dash was opened
on, and it holds marks for workspaces on the other hosts too.

## How it works

- The client keeps one live mirror per host: `useHosts()` lists the configured hosts and
  `getPaseoClient(serverId)` borrows each one's API, and the mirror subscribes to that host's
  workspace and agent directories (the same `list` + `subscribe` streams the rest of the app
  uses). Mirrors are reconciled as hosts connect and disconnect, so one host dropping does not
  re-seed the others. The grouped model is recomputed locally whenever any stream changes or an
  unread mark is set or cleared; each host is indexed separately, since agents and their parents
  never cross hosts.
- The server side exposes small RPCs the client can't do itself because they need the daemon's
  filesystem: reading the workspace-label color catalog, resolving project icons (custom upload
  or automatic discovery), and reading/writing this plugin's own unread marks and viewing
  settings — all under `$PASEO_HOME` on the daemon machine (resolved the way the daemon resolves
  it, including a leading `~`).
- Project icons in SVG or ICO form only render on web and desktop. React Native cannot decode
  those containers on iOS or Android, and a plugin cannot bring its own SVG renderer, so on
  phones and tablets those projects show the same lettered color square Paseo falls back to.
- Plugin RPC has no cross-host form, so the server side only ever runs on the host the dash was
  opened on. Project icons are therefore resolved for that host's projects alone — rows from other
  hosts fall back to the lettered color square — while the label color catalog, unread marks and
  viewing settings from that one host apply to the whole feed.

## Limitations

- The dash only shows a workspace's root agents as pills; subagents running inside their parent's
  workspace contribute to that workspace's activity but do not get their own pill.
- Pull request state, checks, and review decision are only as fresh as what Paseo's daemon has
  already synced from the forge; the plugin does not poll the forge itself.
- Unread marks and viewing settings live on the daemon the dash was opened on. Opening the dash
  from a different host shows that host's marks and settings instead.
- Workspaces on other hosts show the lettered color square rather than their project icon, and
  their workspace labels are colored from the opening host's catalog when the names match.
- Adding and removing labels needs Paseo 0.16.0 or later (0.16.0-beta.1 included) on both the
  app and the host: that is the first release whose SDK lets a plugin assign workspace labels. On
  older versions the label pickers say so instead of offering labels; search, filters, selection
  and bulk archive work on every supported version.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:agents-dash-list
```

From a checkout:

```bash
npm install            # from the monorepo root
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/agents-dash-list
paseo plugin ls        # expect "running"
```

After editing:

```bash
npm run typecheck
paseo plugin reload agents-dash-list
paseo plugin logs agents-dash-list
```
