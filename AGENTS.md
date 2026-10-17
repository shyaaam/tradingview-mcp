1. Work only in this directory, on branches. No git worktrees or copies of the repository anywhere (no
   `git worktree add`, no clones into `/tmp` or `~/.codex/worktrees`). Switch back to `main` when done.
2. Never edit, build or run development commands inside `~/dev/tv-observer-runtime`. It is the live runtime;
   changes reach it only through merged PRs and an owner-approved update.
3. Production is the owner's. Do not edit `production.env`, run migrations or the reviewed-source transition,
   resume the scheduler, or start/stop live V5 unless the owner asked for that exact step. Live experiments use a
   restored database copy and a throwaway branch, removed afterwards.
4. Fix the root cause with the smallest change. Prefer deleting or simplifying over adding.
5. Measure live before choosing any number (timeouts, budgets, retries). One measurement, one change.
6. No new guard, retry, receipt, hash, layer, failure code or migration unless you can name the concrete failure
   it prevents and its cost. If the cost is a missed or deferred observation, log it instead.
7. One source of truth: one config, one function per rule, no duplicate checks, no stale copies. Runtime values
   (commands, provider path, release commit, flags) live only in `~/.config/tv-observer-v5/production.env`;
   launchers must not set them inline, because `--env-file` never overrides variables that are already set.
   When a value changes, search every launcher and config for the old value. Keep backups only under
   `~/dev/tv-observer-runtime/backups/legacy/`.
8. Every PR states lines added / removed and why it cannot be smaller. Net-additive needs a reason.
9. If a fix needs a second patch to work, stop and redesign instead of patching the patch.
10. Verify live (a short smoke) before calling anything done, and report what ran and what it returned. Unit
    tests are not live acceptance.
11. Merge exactly the commit that was tested live, via merge commit, only after CI is green. Never squash from the index.
