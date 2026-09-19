# Contributing

## Agree on the issue before implementing

Behaviour changes need an approved issue first. For a bug fix, open a bug issue;
for a feature or design change, open a design proposal. Discuss the approach and
wait for a maintainer to apply `design-approved` before spending time on a PR.
Approval is our agreement that we intend to merge the proposed change, subject to
implementation review, rather than asking you to build something we may decline.

Link the approved issue in the PR body with `Closes #123` (or `Fixes` / `Resolves`).
Keep the PR in draft until its issue carries `design-approved`. There is no
path-derived bypass for docs-only or test-only changes: deleting a guarding test
can change behaviour. The contributor bypass is a maintainer-applied `trivial`
label on the PR, an explicit judgement rather than a filename heuristic.

The gate is **enforced by draft conversion** when an unapproved PR is
marked ready for review. It posts one comment and updates that comment on later
runs. When a maintainer labels the linked issue `design-approved`, the gate marks
waiting drafts ready for review. The gate does not convert a PR opened
already ready, or an existing ready PR on edits or pushes; those events report a
failing check and a comment. Keep new unapproved PRs in draft yourself.
This repository is private today: no required branch-protection check is
configured; the required-check half must wait until the repository is public.

Maintainer and automation branches in this repository are exempt from the gate;
fork branches never are. Applying `trivial` does not itself re-run the workflow;
re-run it from the checks tab or push to refresh the result.

## Cover every shipped harness

Anything touching a harness-facing surface must cover **OpenCode 1, OpenCode 2,
Pi, OMP, and the Rust module wherever that surface exists there**. Otherwise the
PR is declined as shaped. This is the rule that declined PRs #450 and #461.
A surface genuinely absent from a harness can be marked not applicable; leaving
an existing surface uncovered is not a completed contribution.

Fill in every harness entry in the PR template. The separate harness-coverage
check comments when a changed OpenCode/Pi file has an unchanged conventional
twin. It is advisory only, never converts drafts, and is not proof of complete
coverage: differently named implementations, OpenCode 2, OMP and Rust still need
explicit review.

Run the relevant tests and formatting checks before submitting; CI rejects
unformatted code.
