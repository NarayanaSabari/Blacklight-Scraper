# LinkedIn group collection

The scraper recognizes LinkedIn group `10472901` at
`https://www.linkedin.com/groups/10472901/` as an explicit backend source.
It never supplies a role name or search query for this source.

The collector reuses the LinkedIn credential lease, the credential's profile
and proxy, and the existing browser-pool seat.
It expands the observed `button[aria-label^="see more"]` controls, reads
`.occludable-update [data-view-name="feed-full-update"]`, and extracts the
activity URN from its nested `[data-urn]` element.

The authenticated probe observed the paging request
`/voyager/api/graphql` with query id
`voyagerFeedDashGroupsUpdates.42b722995f2477fa5a9e6797dbd28281` and
`start`, `count`, `groupId`, and opaque `paginationToken` variables.
The captured response places cards at
`data.feedDashGroupsUpdatesByGroupsFeed.elements`.
Each card's `entityUrn` supplies the canonical activity id, while
`commentary.text.text` supplies the post text.
The response metadata supplies the next opaque pagination token and its
expiry time.

The capture did not contain a positive end-of-feed marker.
The browser collector therefore treats a scroll stall or budget boundary as
`incomplete/page_budget` and keeps the source resumable.
It reports `exhausted` only when the transport provides explicit end evidence.
The durable checkpoint cursor serializes the observed token, next start offset,
expiry time, and an optional consumed-post offset for a capped page.
A resumed walk processes the unconsumed backlog before sampling the head,
so a small batch cannot repeatedly fill with the same newest posts.
Claim recovery requests the source-filtered current session with
`source=group`, so a newer normal role session cannot hide a group orphan.
An explicitly expired cursor may fall back to a fresh head sample.
An otherwise unexplained HTTP error, including a generic HTTP 400, fails the
pass without advancing the checkpoint.

The proposed checkpoint is submitted with the one accepted jobs batch as
`group_progress`.
The backend persists it only after delivery/finalization succeeds.
Failed, access-denied, authentication, and unrecognized-markup traversals do not advance the source.
Undelivered submissions retain their source and progress in the local spool.
Spool recovery derives group identity from the original persisted session.
It retains files when that session cannot be verified or the source is disabled,
busy, or not due.
A replay may retain the current checkpoint rather than applying old progress
when the source has advanced since the failed delivery.
A recovered file is reported as queued after its receipt is durable; the normal
import worker performs filtering, normalization, matching, and finalization.

Run the focused tests from this directory with:

```bash
node --test test/scrapers/linkedin-group.test.js
```

The source remains backend-controlled and disabled until an operator enables
it after authenticated feed verification.


## Operation

The source retains the existing US, staffing, age, and non-job eligibility filters.
Canonical LinkedIn activity IDs share the existing duplicate constraint with search results.
Accepted titles map only to existing roles; neutral titles and unmatched jobs stay imported without a role mapping.

The default schedule is every 30 minutes, with a 240-second browser budget per pass.
Normal LinkedIn search and group collection alternate bounded turns and share account capacity.
Other platforms continue independently.

After deploying the migration and both application components, inspect the configuration from the server directory:

```bash
python scripts/configure_linkedin_group.py --group-id 10472901
```

The command is a dry run unless `--commit` is supplied.
An operator can explicitly enable or disable collection:

```bash
python scripts/configure_linkedin_group.py --group-id 10472901 --interval-minutes 30 --enable --commit
python scripts/configure_linkedin_group.py --group-id 10472901 --disable --commit
```

Disabling prevents new claims; already accepted work is allowed to finish.
Source status records posts seen, jobs imported/skipped, the last result, and the next due time.
Authentication, access, and layout failures preserve the acknowledged checkpoint and use the configured retry interval.
An expired lease with accepted unfinished work stays assigned to that session and stages a durable completion retry.

A budgeted pass is not proof that every historical post was collected.
The observed feed has short-lived pagination tokens and no verified end marker.
Expired cursors restart from the head with duplicate protection; a backlog larger than a token's lifetime may require further traversal work before history can be declared complete.
