# Eurosky fork

This is Eurosky's fork of [blacksky-algorithms/atproto](https://github.com/blacksky-algorithms/atproto), which is Blacksky's fork of [bluesky-social/atproto](https://github.com/bluesky-social/atproto). We use it for one thing: the AppView behind `api.eurosky.network` (`packages/bsky`, `services/bsky` and `services/bsync`). eurosky-infra's `appview` role builds it on the AppView host from the commit pinned in `appview_version` (`ansible/inventory/group_vars/identity_appview/vars.yml`). We track Blacksky and keep our own changes small.

## Branches

- **`eurosky`**: Blacksky's `main` plus our changes. Work here: branch off it and open PRs into it.
- **`main`**: Blacksky's `main` as of 2026-08-28, when this fork was made. It is not kept up to date; compare against `upstream/main` instead.

Merge methods:

- **Our PRs:** squash, so each change lands as a single commit that can be reverted on its own.
- **Sync PRs** (`sync/blacksky-*`): **Create a merge commit**. Never squash or rebase them: that drops Blacksky's ancestry, and the next sync conflicts on everything.

## Our commits

The branch starts at Blacksky's `22656646941` (2026-11-18, merge of their #69). Until 2026-11-23 these changes lived in eurosky-infra as `.patch` files; the commit messages carry the full reasoning.

| Commit                                                              | Why                                                                                                                            | Offer to Blacksky?                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| dataplane: case-insensitive handle search in the SQL fallback       | The SQL search fallback missed a handle when the query's case differed.                                                        | Yes                                   |
| dataplane: push bridge falls back to the title "mu", not "Blacksky" | Our pushes go to the mu app (EUR-241).                                                                                         | No: make the title configurable first |
| dataplane: like-subject index migration only records itself         | A plain `CREATE INDEX` on our 17.8B-row like table blocks like writes for hours. Build the index by hand if it is ever wanted. | No                                    |
| dataplane: getKnownLikers starts from the viewer's follows          | "Liked by people you follow" without the like-subject index.                                                                   | Maybe, with the timings               |
| dataplane: only the self labeler record makes an account a labeler  | Accounts with several labeler records failed every page that showed them (EUR-647). The bug is on Blacksky's `main` too.       | Yes                                   |
| dataplane: bsync-subscription keeps its cursor in the database      | A restart resumes instead of replaying bsync's whole log (EUR-469).                                                            | Yes                                   |
| bsky: tests for the Eurosky commits (tests/eurosky)                 | Tests for the commits above.                                                                                                   | With each commit                      |

Tests for our changes live in `packages/bsky/tests/eurosky/`. Each PR that changes behavior adds or updates one there.

## CI

Blacksky's [repo.yaml](.github/workflows/repo.yaml) (build, verify and the full test suite, `tests/eurosky/` included) runs on every PR. Its first job fails without a changeset, so add one to each PR (`pnpm changeset`, or a file in `.changeset/`). The other workflows run on pushes to `main` (images, npm publishing, Blacksky's internal sync) or need Blacksky's secrets (`anarres.yml`, which then does nothing), so none of them does anything here.

To run our tests locally (node and pnpm as in `package.json` `devEngines`; Postgres and Redis from `packages/dev-infra/docker-compose.yaml`, services `db_test` and `redis_test`):

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run --recursive --filter '@atproto/dev-env...' build
cd packages/bsky
DB_POSTGRES_URL=postgresql://pg:password@127.0.0.1:5433/postgres \
  REDIS_HOST=127.0.0.1:6380 corepack pnpm exec vitest run tests/eurosky/
```

The dev environment loads `@atproto/bsky` from `dist`, so rebuild it (`corepack pnpm --filter @atproto/bsky build`) after changing `src`. Use a fresh test database: the dev environment migrates an existing schema instead of recreating it.

## Deploying

Merge into `eurosky`, then bump `appview_version` in eurosky-infra to the new commit and converge `playbooks/site/appview.yml`. The converge checks the commit out, rebuilds and restarts the four AppView units. Before bumping past a sync, read every new migration in `packages/bsky/src/data-plane/server/db/migrations/`: the dataplane runs them all at boot in one transaction, and a plain `CREATE INDEX` or a table rewrite on `like`, `post` or `follow` stalls the AppView for hours (the role's README has the details).

## Syncing with Blacksky

There is no sync workflow; merge Blacksky's `main` by hand:

```bash
git remote add upstream https://github.com/blacksky-algorithms/atproto.git   # once
git fetch upstream origin
git switch -c sync/blacksky-$(date +%F) origin/eurosky
git merge upstream/main
# resolve, then: corepack pnpm install && corepack pnpm build, and run tests/eurosky/
git push -u origin HEAD   # open a PR into eurosky, merge with a merge commit
```

`pnpm-lock.yaml` conflicts: we add no dependencies, so take Blacksky's version (`git checkout --theirs pnpm-lock.yaml`) and run `pnpm install`. Turn on `git config rerere.enabled true` so git reuses your earlier conflict resolutions.

## When Blacksky covers one of our changes

Revert ours on the sync branch **before** merging, and name what replaced it:

```bash
git switch -c sync/blacksky-$(date +%F) origin/eurosky
git revert <commit>   # "Drop <change>: superseded by blacksky-algorithms/atproto#NNN"
git merge upstream/main
```

Then remove its row from the table above.
