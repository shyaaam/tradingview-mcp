# Working rules for agents

These apply to every agent (Codex, Claude Code, others) working in this repository.

1. **Work only in this directory, on branches.** Do not create git worktrees or copies of the repository
   (no `git worktree add`, no clones into `/tmp` or `~/.codex/worktrees`). Use a branch in this checkout and
   switch back to `main` when you are done.
2. **Never edit, build or run development commands inside `~/dev/tv-observer-runtime`.** It is the live runtime
   (provider and app checkouts, backups, logs, reports). Changes reach it only through merged PRs followed by an
   owner-approved update.
3. **Production is the owner's.** Do not edit `~/.config/tv-observer-v5/production.env`, run migrations or the
   reviewed-source transition, resume the scheduler, or start/stop the live V5 process unless the owner asked for
   that exact step. Live experiments use a restored copy of the database and a throwaway branch, and are removed
   afterwards.
4. **Name the failure before adding a guard.** Before adding any check, receipt, hash, failure code, migration or
   retry, write down the concrete failure it prevents and what that failure costs. If you cannot, do not add it.
5. **Report facts.** Say what was run and what it returned. Do not claim live acceptance from unit tests.
