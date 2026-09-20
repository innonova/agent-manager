# The web UI, a rethink: first reading (Fable 5.1)

Written 2026-09-20 from screenshots of every screen at 1280×720 and
from a day of using it to run agents. A second reading by Codex
gpt-6-astra sits beside it. Neither is applied until a person has read
both; the work, when it comes, is a feature done in the session,
since it is decided by taste.

## What the app is for, seen from the screens

A person starts agents, gives them work in conversation, reads what
they did, and reviews features. Since today, agents start agents and
the person watches more than types. So the screen that matters is the
transcript, and the second is the list of what is happening. Both are
reading screens. The UI was built page by page as features landed and
reads like it: every page is right on its own and the whole has no
hierarchy.

## The agent view

**The header** is the densest thing in the app and the most read. Two
lines of 10.5 px text mix three kinds of thing at one weight: status
(state badge, model chip, usage), identity (profile, working directory,
the harness link) and actions (stop, restart, archive, delete, "2
changed since you last looked"). The actions are text links in the same
grey as the facts. A reader cannot tell at a glance what is a fact and
what is a button, which is why the harness link looked crooked before
it looked wrong: it was a button dressed as a label beside a label in
another font.

Change: one line. The name, the state, the model, and one place for
actions (a small group of real buttons at the right, or a menu). The
facts, usage, profile, directory, harness, effort, into a details row
that opens on the name or lives in a tooltip, since none of them is
read more than once an hour. Keep the "changed since you last looked"
link, but as the one thing on that line that is coloured.

**The transcript** uses a chat layout: the person's messages are
right-aligned blue bubbles with "admin" above each; the agent's replies
are unbounded plain text; tool calls fold to a row; turn ends are a
centred rule with time and duration. The rule and the folded rows are
right. The bubbles are not: this is a technical transcript read in
long stretches, and a chat layout makes the eye jump across a 670 px
column for every exchange and wastes the width on the agent's side.

Change: left-align everything in one column, mark the author in a
gutter (name and time, once per message, muted), keep the person's
messages distinct by a thin left border or a tint, not a bubble. Keep
the turn rule, the folded tool rows, the activity line and its
reservation, the thinking summaries as they are.

**The composer** is right: one box, the buttons that apply, the
placeholder saying what Enter does. Shorten the placeholder while the
agent works; "a message now is seen at its next step" is a sentence
for the tooltip.

**The sidebar** is right in structure, projects as a tree with agents
under them, archived folded away. Two weights would help: the state
badges are as heavy as the names, and a dot with the state word in
grey would let the names carry the column. "+ new" at 10 px beside a
project name is the most used action in the tree and the smallest
thing in it.

## The projects page

Four configuration blocks (account usage, harness note, models, method
with learnings) sit above the projects, which are what the page is
named for and what a person comes to it for. On a fresh install the
projects are below the fold of the settings.

Change: projects first, as the page's list, with usage as one quiet
line at the top. The four blocks become a "this machine" page reached
from the gear menu, or a section under the list; they are read once a
week and edited less. The blocks themselves are fine; it is their
place that is wrong.

## The files view

Right for what it is: a tree, a read-only editor, a changes view, the
upload and folder actions as icons. Two small things: "into project"
as the target label reads as a preposition without an object until one
knows it means the repository named "project"; and the empty state
sentence is the only text on a screen that could show the repository's
README instead.

## The features view

Cannot be judged empty, and the empty state is good: it says what a
feature is and how work starts. With content, this page is the work
board, and it should read as one: grouped by status in the order of
the handshake (planned, in progress, review, blocked, done), priority
within, the report's date on the row, and the reviewer's last word.
That is a feature of its own once the run log and reviews have a few
weeks in them.

## Across the app

- **Type is too small.** `text-xs` at 10.5 px is the app's default
  for anything that is not a transcript paragraph, and this is a
  reading app. Body at 14 px, metadata at 12 px, nothing below.
- **Blue means too many things.** Links, buttons, badges, the person's
  bubbles, the selected row. Reserve it for what can be clicked; states
  get their own colours as they do in the sidebar.
- **Dark mode** exists throughout and every change above has to be
  looked at in both, since the crooked link was reported from dark.
- **The floating toolbar** at the bottom of the screenshots is the dev
  server's devtools, not the UI.

## Direction, in one paragraph

Make it a reading app. One column of transcript, left-aligned,
authored in the gutter, rules between turns; one header line with the
facts folded away; the tree beside it as it is; projects on the
projects page and the machine's settings on their own; bigger type,
fewer blue things. Keep the activity line, the folded tool rows, the
turn rules, the tree, the composer. Do it as one feature, in the
session, looked at in both modes at two widths before it is gated.
