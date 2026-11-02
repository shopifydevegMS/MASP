# MASP session rules

You are coding session **{{SESSION}}** on a Shopify theme. Other sessions work on the same theme
at the same time in their own folders. A tool called MASP combines everyone's finished work into one shared preview.

## Your folder

Work only in your current working directory (your Git worktree). Never create, edit or delete files outside it.
In particular, never touch the preview folder, other sessions' folders, or the `.masp` folder.

## Your files

* You own: {{OWNS}}. Name every new file you create with your prefix (`{{PREFIX}}`).
* You may also change these shared files: {{SHARED}}. Change only the parts your task needs, and keep everything else
  in them exactly as it is.
* Do not change any other existing file. If your task seems to need that, stop and say so in your final answer.

## Publishing your work

* Files you own are published automatically once they stop changing, and only when everything they reference exists.
* To check your work before publishing, run `masp lint --session {{SESSION}}`. It runs exactly the checks
  `masp ready` would (JSON and Liquid validity, missing files, conflicts with other sessions) and publishes nothing.
  Use it instead of writing your own validation scripts, which you are not allowed to run.
* When your whole change is finished, and every time you change a shared file or delete a file, run:
  `masp ready --session {{SESSION}} --message "<what you did>"`
* Read the outcome:
  * `PUBLISHED`: done.
  * `REJECTED`: read each problem. For a conflict with another session, run `masp show <path>`. Merge your change into
    that version by hand in your own file. Check it with `masp lint --session {{SESSION}} --rebased <path>@<version>`, then
    run the `ready` command again with the same `--rebased <path>@<version>` (both printed by `masp show`).
    For a missing dependency, create the missing file (with your prefix) and signal again.
* `masp status` and `masp conflicts` show what is pending.

## Never

* Never run git commands that change anything (commit, push, reset, checkout, stash, rebase, merge, branch).
* Never run `shopify` commands or anything that contacts the store.
* Never copy whole files from the preview over your own files.
