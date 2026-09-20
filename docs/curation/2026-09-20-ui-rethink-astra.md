# The web UI, a rethink: second reading (Codex gpt-6-astra)

Given four screenshots at 1280×720 (the agent view working, the projects page, the files view, the features view) and asked, per screen, what the person is there to do, what helps, what gets in the way, what to change and what to keep, then a direction for the whole. Unedited. The first reading, by Fable 5.1, is beside it.

---

The main opportunity is hierarchy. Small, pale text carries almost everything: the work itself, navigation, explanations and operational details. Meanwhile, substantial space goes unused. I would give the person’s task more visual weight and make supporting information quieter through placement, rather than making it difficult to read.

**1. Agent view**

The person is here to understand progress, read the result and intervene when needed. Increasingly, they also need to understand who assigned the work and which agent is responsible.

The persistent agent list, readable transcript column, collapsed tool row and bottom composer provide a useful structure. The activity strip sits close to where someone would send a message. Human messages are immediately distinguishable.

Several things compete with that structure:

- The sidebar contains two “worker” rows and two “reviewer” rows. State badges distinguish their current conditions, but their identities and relationships remain unclear.
- The header gives considerable space to profile, usage, harness and filesystem information. Nothing visible identifies the current assignment beyond the conversation.
- “Stop,” “restart,” “archive” and “delete” form a tiny, undifferentiated row. “Interrupt” appears separately beside the composer; the distinction between the two stopping controls is unclear here.
- Bright blue human-message bubbles dominate the comparatively small agent output. Timestamps, durations and large vertical gaps fragment a transcript that contains relatively little text.
- The long composer placeholder contains important interaction instructions that will disappear during typing.

I would strengthen the agent name and current assignment, with a compact state immediately beside them. Show “started by…” where that relationship exists; offer grouping by parent without forcing a deeply indented tree. Keep names independently distinguishable.

Increase transcript text to roughly 15–16 px, reduce space between short related items, and soften human-message backgrounds. Keep tool details collapsed. Put model and usage details behind a compact disclosure; retain changed-files access prominently. Group lifecycle controls in a menu, keeping the immediate intervention action beside the composer.

Align the composer and activity strip with the reading column. Move the working-message explanation into short, persistent helper text. Keep the conversation as the largest and strongest element.

**2. Projects page**

The person is here to enter an existing project, see where attention is needed or create a project.

The project rows are compact and easy to scan once reached. Names, repository paths and agent summaries are useful. The “new project” action is clear.

But four configuration panels precede the projects. The first project begins around two-thirds of the way down the screen. Harness, models and method explanations occupy more space than the actual project list. In the method panel, repeated “the shipped text” and “view / edit” links make the relationship between method and framing difficult to parse.

I would put projects directly under the title. Each row should lead with its name, followed by meaningful attention signals: agents working, agents waiting for an answer, features awaiting review. Show repository names secondarily, with full paths available when needed.

Move harness, models, method, framing and learnings into a clearly named installation-level area, accessible from the global navigation. Their current explanatory prose belongs on those destination pages. Keep account usage available as one compact summary rather than the first large panel.

Keep the restrained row treatment and central content width. Increase row text and make the entire project destination easy to select; leave editing as a secondary action.

**3. Files view**

The person is here to inspect an artifact, find a file or understand what changed.

The tree-and-reader split is appropriate. Multiple repository roots are visible, and “Changes 2” supplies a useful reason to investigate. The white reading surface is worth keeping.

The screenshot is an unselected state, so it cannot establish whether file typography or diff presentation works. What it does show is a very small cluster of controls above an otherwise empty workspace. “Into project” has an unclear relationship to the icons beside it. Those controls have no visible labels, while the main pane explains that files are read-only. “Filter loaded entries” exposes a technical limitation without making the search scope especially clear.

I would give the sidebar a clearer sequence: repository scope, file search/filter, then the tree. Distinguish “filter this tree” from any repository-wide search. Label consequential file actions visibly and separate them from navigation.

Use the empty reader to provide a useful starting point: “Select a file” and a direct “View 2 changed files” action. Keep the read-only explanation as short secondary text. Once a file is selected, its path should anchor the reader header, with revision or freshness information alongside it when relevant.

Keep the compact tree and generous reader. Empty space here can belong to the document; it does not need decorative content.

**4. Features view**

The person is here to define work, see its progress and review what an agent delivered.

The project navigation and “new feature” action are clear. The page also explains that work is assigned through conversation, which is an important expectation.

This screenshot shows only the empty state. It offers no evidence about the populated list or review experience. The visible weakness is duplicated explanation: the small sentence beside “Features” and the paragraph beneath it both describe feature files and conversational assignment. Storage details lead before the benefit of using features.

I would replace both with a brief explanation: “Track work here. Give a feature to an agent in conversation, then review its report.” Place “Create a feature” with that explanation so the empty state has one obvious next step.

For the populated direction, prioritise features awaiting review, then work in progress, then planned work. Rows should lead with a descriptive title; status, responsible agent, repository and latest update should support it. Reviewing should bring the latest report, relevant changes and response controls together, while preserving access to the specification and history.

Keep the simple page structure. There is no evidence here that it needs a board or a more elaborate dashboard.

**Proposed direction for the whole**

Organise the visual hierarchy around three recurring activities: **find the work, follow the work, review the result**.

Keep the existing project navigation and split-pane workspaces. Establish consistent content widths, title placement and spacing across pages. Use a readable text scale: approximately 15–16 px for conversation and reports, 14 px for navigation and lists, and smaller text sparingly for supporting metadata. Reserve monospace for code, paths and identifiers.

Give blue a narrower role: primary actions, links and selection. Make selection unmistakable, and make waiting-for-a-person more noticeable than routine working or idle states. Move configuration explanations and maintenance controls away from the primary reading path.

As delegation grows, expose relationships where decisions happen: who started this agent, what work it is doing, and where its report belongs. Connect conversations, features and changes through direct links.

The desired character is a quiet, readable working tool. Preserve its restraint while making important content larger, relationships clearer and everyday actions easier to locate.
