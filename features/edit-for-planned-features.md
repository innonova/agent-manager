---
title: edit for planned features
status: done
priority: 100
---

not yet run features should be editable

## Report (2026-09-12)

Planned features have an "edit" action on their row that opens a dialog
for title, description and priority, in the same style as "new
feature". The description field holds the whole file below the
frontmatter, so on a feature sent back with a response you edit the
conversation too; that seemed better than hiding it. The slug is not
editable, since that is a file rename.

Manager side: the PATCH endpoint that set the status now takes any of
status, title, body, priority and dependsOn, validates each, refuses an
empty edit, and announces the change. Editing is allowed by the API at
any status; the UI offers it for planned features only, which is what
"not yet run" comes down to in the new model.

Verified by a manager test (edit, bad values, empty edit) and the UI
features test (edit the title, see the row update). Left open: nothing.
