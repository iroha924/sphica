-- The source of truth for Sphica's database (SQLite, `node:sqlite`): the memory of past implementation and decisions for one owner on one machine.
-- Generation 2. `sphica_generation` holds the generation; `pragma user_version` is the revision within it.
-- A database of another generation is refused without being changed.
--
-- Four boundaries:
--   captured sources   session, source, artifact_link, edit_observation, external_reference: what was said or written, never rewritten
--                      (the owner can forget chosen sources: forget_batch and source_forgotten keep what was removed, without its text)
--   extracted units    unit and its option, evidence, adoption, link, state, anchor, alias tables: what was decided or implemented
--   processing         extraction_run, source_processing: what has been looked at and saved, so gaps are counted
--   work and delivery  work, delivery, delivery_unit: the current work status and what the hooks injected
-- Every table is STRICT and every primary key is not null. Times are ISO 8601 UTC (`Date#toISOString()`); `strftime(...) is column` rejects others.
-- Byte offsets are into the UTF-8 bytes of source.text. Project consistency across tables is enforced by triggers, not only by code.
-- Every foreign key is led by an index on its own columns (a partial one where the column can be null), so removing or moving a parent
-- row looks its children up instead of scanning them.

create table sphica_generation (generation integer not null check (generation = 2)) strict;
insert into sphica_generation values (2);

create table project (
  id integer primary key autoincrement not null,
  key text not null unique check (
    (key glob 'git:*' and key not glob '*[ ' || char(9) || '-' || char(13) || ']*' and length(key) > 4)
    or (key glob 'local:[a-z0-9]*' and substr(key, 7) not glob '*[^a-z0-9._-]*')),
  name text not null check (name <> ''),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    check (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is created_at)
) strict;

-- Identities bound to the owner of this machine (the owner's GitHub account id), set by the owner through the CLI.
-- An external source counts as the owner's words only when its author id matches; a login name alone never does.
create table owner_identity (
  provider text not null check (provider in ('github')),
  external_id text not null check (external_id <> ''),
  login text,
  bound_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', bound_at) is bound_at),
  primary key (provider, external_id)
) strict;

-- One coding session. The id is a uuid derived from (project, host, external_id), so resending is idempotent.
create table session (
  id text primary key not null,
  project_id integer not null references project (id) on delete cascade,
  host text not null check (host in ('claude-code', 'codex')),
  external_id text not null,
  branch text,
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  unique (project_id, host, external_id)
) strict;

-- A captured source, kept as retained and never updated. A changed external item (an edited PR body) is a new revision.
-- author_kind: owner (a session prompt from the host's own user, or an author matching owner_identity), assistant (a session reply),
-- person (anyone else), bot.
-- available_at: when this revision became visible where it lives (a PR body revision's edit time), verified from the provider;
-- null when that cannot be established, and then no as-of snapshot may include this revision.
create table source (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  kind text not null check (kind in ('session_message', 'pr_body', 'issue_body', 'pr_comment', 'issue_comment', 'review',
    'review_comment', 'commit_message', 'pr_event', 'file_excerpt')),
  -- The artifact it belongs to: `session:<uuid>`, `pr:<n>`, `issue:<n>`, `commit:<sha>`, `file:<path>`
  artifact text not null check (artifact <> ''),
  external_id text not null check (external_id <> ''),
  revision integer not null check (revision > 0),
  session_id text references session (id) on delete cascade,
  turn_id text,
  author_kind text not null check (author_kind in ('owner', 'assistant', 'person', 'bot')),
  author_login text,
  author_external_id text,
  author_association text,
  -- The comment or thread this replies to, or the thread a resolution event closed
  parent_external_id text,
  -- For pr_event: merged | closed | reopened | thread_resolved
  event_kind text check (event_kind in ('merged', 'closed', 'reopened', 'thread_resolved')),
  url text,
  created_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is created_at),
  available_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', available_at) is available_at),
  captured_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', captured_at) is captured_at),
  text text not null,
  truncated integer not null default 0 check (truncated in (0, 1)),
  redacted integer not null default 0 check (redacted in (0, 1)),
  original_bytes integer not null check (original_bytes >= 0),
  content_hash blob not null check (length(content_hash) = 32),
  -- Code position of a review comment or a file excerpt: a normalized repository-relative path with forward slashes
  path text check (path is null or (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..' and path not glob '*\*' and path not glob '[A-Za-z]:*' and path not glob '*//*'
    and path not glob './*' and path not glob '*[/].[/]*')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  diff_hunk text,
  commit_sha text check (commit_sha is null or (length(commit_sha) = 40 and commit_sha not glob '*[^0-9a-f]*')),
  blob_sha text check (blob_sha is null or (length(blob_sha) = 40 and blob_sha not glob '*[^0-9a-f]*')),
  -- 1 when searched in the source index (owner words and third-party text; assistant replies are not)
  indexed integer not null check (indexed in (0, 1)),
  check ((kind = 'session_message') = (session_id is not null)),
  check ((kind = 'pr_event') = (event_kind is not null)),
  check (kind <> 'session_message' or author_kind in ('owner', 'assistant')),
  check (kind = 'session_message' or author_kind <> 'assistant'),
  check (kind <> 'file_excerpt' or (path is not null and commit_sha is not null and blob_sha is not null
    and line_start is not null and line_end is not null)),
  check (truncated = 1 or redacted = 1 or original_bytes = length(cast(text as blob)))
) strict;
create index source_artifact on source (project_id, artifact, created_at);
create index source_session on source (session_id, created_at) where session_id is not null;
-- A captured message id is unique within its session; everything else within its project and kind
create unique index source_message_once on source (session_id, external_id, revision) where session_id is not null;
create unique index source_item_once on source (project_id, kind, external_id, revision) where session_id is null;

-- An external source may claim the owner only through a bound identity; a retry with different bytes is refused, not silently dropped
create trigger source_owner_bound before insert on source
when new.kind <> 'session_message' and new.author_kind = 'owner'
  and not exists (select 1 from owner_identity where provider = 'github' and external_id = new.author_external_id) begin
  select raise(abort, 'owner authorship needs a bound owner identity');
end;
create trigger source_session_project before insert on source when new.session_id is not null
  and not exists (select 1 from session where id = new.session_id and project_id = new.project_id) begin
  select raise(abort, 'source and session belong to different projects');
end;
create trigger source_no_update before update on source begin
  select raise(abort, 'sources are never rewritten; capture a new revision');
end;

create virtual table source_fts using fts5(lexemes, content='', contentless_delete=1);
create trigger source_fts_ai after insert on source when new.indexed = 1 begin
  insert into source_fts (rowid, lexemes) values (new.id, sphica_terms(new.text));
end;
create trigger source_fts_ad after delete on source when old.indexed = 1 begin
  delete from source_fts where rowid = old.id;
end;

-- PR ↔ issue and other artifact references (by artifact, not by a particular revision)
create table artifact_link (
  project_id integer not null references project (id) on delete cascade,
  from_artifact text not null,
  to_artifact text not null,
  kind text not null check (kind in ('references', 'closes')),
  primary key (project_id, from_artifact, to_artifact, kind)
) strict;

-- A reference the owner gave that Sphica could not fetch (a meeting-notes URL). It never counts as a fetched source:
-- a claim supported only by it stays unsourced until the text is fetched and checked.
create table external_reference (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  url text not null check (url <> ''),
  owner_source_id integer not null references source (id),
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at)
) strict;
create index external_reference_project on external_reference (project_id);
create index external_reference_source on external_reference (owner_source_id);

-- One owner-confirmed deletion of chosen sources. It stands in for an extraction run on the state changes the deletion causes.
create table forget_batch (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', at) is at)
) strict;
create index forget_batch_project on forget_batch (project_id);

-- A source the owner forgot: its original id and identity, never its text. Capture, harvest, and glean skip an item matching one,
-- so the same words are not stored again; changed text is new speech and is stored. source_id has no foreign key: the row is gone.
create table source_forgotten (
  source_id integer primary key not null,
  project_id integer not null references project (id) on delete cascade,
  artifact text not null,
  kind text not null,
  external_id text not null,
  -- An older revision left behind is not the item's current text, and new text numbers after the forgotten one
  revision integer not null check (revision > 0),
  content_hash blob not null check (length(content_hash) = 32),
  batch_id integer not null references forget_batch (id) on delete cascade
) strict;
create index source_forgotten_batch on source_forgotten (batch_id);
-- Not unique: an edited item that returns to earlier text has two revisions with the same hash, and both can be forgotten
create index source_forgotten_item on source_forgotten (project_id, artifact, kind, external_id, content_hash);

-- A file path an edit tool reported, or that a turn-boundary git status snapshot found. It is not an implementation record.
create table edit_observation (
  id integer primary key autoincrement not null,
  session_id text not null references session (id) on delete cascade,
  turn_id text,
  tool_event_id text,
  path text not null check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..' and path not glob '*\*' and path not glob '[A-Za-z]:*'),
  via text not null check (via in ('tool', 'status')),
  observed_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) is observed_at),
  unique (session_id, turn_id, path, via)
) strict;
create index edit_observation_path on edit_observation (path);

-- One extraction by trace, harvest, or glean. target names what it read: `session:<uuid>`, `pr:<n>`, or `glean`.
-- A migration that changes lifecycles records itself as a run too (origin migration, target `revision:<n>`), so each change names where it came from.
create table extraction_run (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  origin text not null check (origin in ('trace', 'harvest', 'glean', 'migration')),
  target text not null,
  session_id text references session (id) on delete set null,
  status text not null check (status in ('running', 'saved', 'failed', 'capped')),
  reason text,
  input_bytes integer check (input_bytes >= 0),
  -- The CLI-issued draft this run saves. A saved run's draft saves nothing again; the draft is bound to this run's project and target
  draft_id text unique,
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  finished_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) is finished_at),
  check (status in ('running', 'saved') or reason is not null)
) strict;
create index extraction_run_project on extraction_run (project_id);
create index extraction_run_session on extraction_run (session_id) where session_id is not null;

-- Which sources an extraction looked at, and what came of them
create table source_processing (
  source_id integer not null references source (id) on delete cascade,
  run_id integer not null references extraction_run (id) on delete cascade,
  outcome text not null check (outcome in ('units', 'no_unit', 'failed', 'capped')),
  primary key (source_id, run_id)
) strict;
create index source_processing_run on source_processing (run_id);

-- An extracted unit. Its text is never rewritten: corrections are successors, withdrawals, retractions, and anchor replacements.
-- extraction: supported (every evidence span was found in retained text) or quarantined (with reason).
-- lifecycle changes only through unit_state (its trigger sets this column). revision rises with every change to the unit's relations,
-- so a draft made against an older revision is refused.
create table unit (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  -- `<origin>:<target>/<key>` for trace and harvest, `glean:<key>` for glean
  key text not null,
  kind text not null check (kind in ('decision', 'implementation', 'finding', 'dead_end', 'question', 'constraint')),
  stance text check (stance in ('do', 'dont', 'defer')),
  text text not null check (text <> ''),
  why text,
  scope_note text,
  revisit_when text,
  no_code_surface text,
  extraction text not null check (extraction in ('supported', 'quarantined')),
  extraction_reason text,
  lifecycle text not null default 'candidate' check (lifecycle in ('candidate', 'active', 'superseded', 'withdrawn')),
  unsourced integer not null default 0 check (unsourced in (0, 1)),
  revision integer not null default 1 check (revision > 0),
  run_id integer not null references extraction_run (id),
  created_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is created_at),
  -- Hash of text, why, scope_note, revisit_when, and the options (in position order), computed by the save path
  content_hash blob not null check (length(content_hash) = 32),
  unique (project_id, key),
  check ((stance is null) = (kind not in ('decision', 'constraint'))),
  check (revisit_when is null or stance = 'defer'),
  check ((extraction = 'quarantined') = (extraction_reason is not null)),
  check (extraction = 'supported' or lifecycle = 'candidate'),
  check (unsourced = 0 or lifecycle <> 'active')
) strict;
create index unit_live on unit (project_id, lifecycle, kind);
create index unit_run on unit (run_id);
create trigger unit_insert_candidate before insert on unit when new.lifecycle <> 'candidate' begin
  select raise(abort, 'units start as candidates');
end;
create trigger unit_run_project before insert on unit
when not exists (select 1 from extraction_run where id = new.run_id and project_id = new.project_id) begin
  select raise(abort, 'unit and run belong to different projects');
end;
-- Everything a unit was saved with is frozen, so a quarantined or unsourced unit cannot be relabelled and then activated
create trigger unit_text_frozen before update of project_id, key, kind, stance, text, why, scope_note, revisit_when, no_code_surface,
  extraction, extraction_reason, unsourced, run_id, created_at, content_hash
on unit begin
  select raise(abort, 'unit text is never rewritten; record a successor');
end;
create trigger unit_revision_step before update of revision on unit when new.revision is not old.revision + 1 begin
  select raise(abort, 'a unit''s revision rises by one with each change to its relations');
end;
create trigger unit_lifecycle_via_state before update of lifecycle on unit
when new.lifecycle is not (select to_state from unit_state where unit_id = new.id order by id desc limit 1) begin
  select raise(abort, 'lifecycle changes only through unit_state');
end;

-- Options are part of the unit's text: written with it, never updated or removed on their own
create table unit_option (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  position integer not null check (position > 0),
  text text not null check (text <> ''),
  outcome text not null check (outcome in ('chosen', 'rejected', 'deferred', 'proposed')),
  why text,
  -- For a rejected option, what the owner said would make it worth reconsidering; its words are a `reconsiders` evidence row on the option
  reconsider_when text check (reconsider_when <> ''),
  unique (unit_id, position),
  check (reconsider_when is null or outcome = 'rejected'),
  unique (unit_id, id)
) strict;
create trigger unit_option_sealed before insert on unit_option
when exists (select 1 from unit_state where unit_id = new.unit_id) or exists (select 1 from unit_alias where unit_id = new.unit_id) begin
  select raise(abort, 'options are written with the unit, before its first state; record a successor instead');
end;
create trigger unit_option_frozen before update on unit_option begin
  select raise(abort, 'options are never rewritten; record a successor');
end;
create trigger unit_option_no_delete before delete on unit_option
when exists (select 1 from unit where id = old.unit_id) begin
  select raise(abort, 'options are never removed on their own');
end;

-- A span of a source supporting a unit or one of its options. Retraction marks it mistaken without deleting it.
create table unit_evidence (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  option_id integer,
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  role text not null check (role in ('states', 'proposes', 'rejects', 'explains', 'implements', 'reconsiders')),
  -- A third party the owner reported ("X said ..."): hearsay by the owner, never X's own statement
  reported_speaker text,
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  retracted_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', retracted_at) is retracted_at),
  retraction_reason text,
  retraction_source_id integer references source (id),
  retraction_span_start integer,
  retraction_span_end integer,
  foreign key (unit_id, option_id) references unit_option (unit_id, id) on delete cascade,
  check ((retracted_at is null) = (retraction_reason is null)),
  check ((retracted_at is null) = (retraction_source_id is null)),
  check ((retraction_source_id is null) = (retraction_span_start is null)),
  check ((retraction_source_id is null) = (retraction_span_end is null)),
  check (retraction_span_end is null or retraction_span_end > retraction_span_start)
) strict;
create unique index unit_evidence_unit_once on unit_evidence (unit_id, source_id, span_start, span_end, role) where option_id is null;
create unique index unit_evidence_option_once on unit_evidence (option_id, source_id, span_start, span_end, role) where option_id is not null;
create index unit_evidence_source on unit_evidence (source_id);
create index unit_evidence_option on unit_evidence (unit_id, option_id);
create index unit_evidence_retraction on unit_evidence (retraction_source_id) where retraction_source_id is not null;
create index unit_evidence_run on unit_evidence (run_id);

-- Evidence that the project adopted a decision or constraint. route: owner_statement (an owner-kind source span) or
-- explicit (an explicit disposition in a source, such as a maintainer's reply saying it is adopted). A merge or a resolved thread is never adoption.
create table unit_adoption (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  route text not null check (route in ('owner_statement', 'explicit')),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  retracted_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', retracted_at) is retracted_at),
  retraction_reason text,
  retraction_source_id integer references source (id),
  retraction_span_start integer,
  retraction_span_end integer,
  unique (unit_id, source_id, span_start, span_end),
  check ((retracted_at is null) = (retraction_reason is null)),
  check ((retracted_at is null) = (retraction_source_id is null)),
  check ((retraction_source_id is null) = (retraction_span_start is null)),
  check ((retraction_source_id is null) = (retraction_span_end is null)),
  check (retraction_span_end is null or retraction_span_end > retraction_span_start)
) strict;
create index unit_adoption_source on unit_adoption (source_id);
create index unit_adoption_retraction on unit_adoption (retraction_source_id) where retraction_source_id is not null;
create index unit_adoption_run on unit_adoption (run_id);
create trigger unit_adoption_route before insert on unit_adoption begin
  select raise(abort, 'owner_statement adoption needs an owner-authored source')
  where new.route = 'owner_statement' and not exists (select 1 from source where id = new.source_id and author_kind = 'owner');
  select raise(abort, 'explicit adoption needs the owner or a maintainer (OWNER, MEMBER, COLLABORATOR association)')
  where new.route = 'explicit' and not exists (select 1 from source where id = new.source_id
    and (author_kind = 'owner' or author_association in ('OWNER', 'MEMBER', 'COLLABORATOR')));
  select raise(abort, 'merge and thread resolution events are not adoption')
  where exists (select 1 from source where id = new.source_id and kind = 'pr_event');
  select raise(abort, 'adoption applies to decisions and constraints')
  where not exists (select 1 from unit where id = new.unit_id and kind in ('decision', 'constraint'));
end;

create table unit_link (
  from_unit integer not null references unit (id) on delete cascade,
  to_unit integer not null references unit (id) on delete cascade,
  kind text not null check (kind in ('supersedes', 'implements', 'conflicts')),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  -- A conflict stays unresolved (and suppresses automatic delivery of both) until resolved with a reason
  resolved_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) is resolved_at),
  resolution text,
  primary key (from_unit, to_unit, kind),
  check (from_unit <> to_unit),
  check ((resolved_at is null) = (resolution is null)),
  check (kind = 'conflicts' or resolved_at is null)
) strict;
-- Lookups by the unit a link points at: its successors, and its conflicts from either side
create index unit_link_to on unit_link (to_unit, kind);
create index unit_link_run on unit_link (run_id);
create trigger unit_link_frozen before update on unit_link begin
  select raise(abort, 'links are frozen; only an unresolved conflict can be resolved, once')
  where new.from_unit is not old.from_unit or new.to_unit is not old.to_unit or new.kind is not old.kind
    or new.run_id is not old.run_id or new.added_at is not old.added_at or old.resolved_at is not null or old.kind <> 'conflicts';
end;
create trigger unit_link_no_delete before delete on unit_link
when exists (select 1 from unit where id = old.from_unit) and exists (select 1 from unit where id = old.to_unit) begin
  select raise(abort, 'links are never removed on their own');
end;
create trigger unit_link_supersedes_acyclic before insert on unit_link when new.kind = 'supersedes' begin
  select raise(abort, 'supersedes links cannot form a cycle')
  where exists (
    with recursive chain(id) as (
      select new.to_unit union select l.to_unit from unit_link l join chain on l.from_unit = chain.id where l.kind = 'supersedes')
    select 1 from chain where id = new.from_unit);
end;

-- Lifecycle history and the only route for lifecycle changes. The trigger checks the rules and then sets unit.lifecycle.
-- A change comes from an extraction run, or from the owner forgetting sources (forget_id). source_id becomes null when its source is forgotten.
create table unit_state (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  from_state text check (from_state in ('candidate', 'active', 'superseded', 'withdrawn')),
  to_state text not null check (to_state in ('candidate', 'active', 'superseded', 'withdrawn')),
  at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', at) is at),
  reason text not null check (reason <> ''),
  source_id integer references source (id) on delete set null,
  run_id integer references extraction_run (id),
  forget_id integer references forget_batch (id),
  check ((run_id is null) <> (forget_id is null))
) strict;
create index unit_state_order on unit_state (unit_id, id);
create index unit_state_source on unit_state (source_id) where source_id is not null;
create index unit_state_run on unit_state (run_id) where run_id is not null;
create index unit_state_forget on unit_state (forget_id) where forget_id is not null;
create trigger unit_state_rules before insert on unit_state begin
  select raise(abort, 'the first state of a unit is candidate, from no state')
  where not exists (select 1 from unit_state where unit_id = new.unit_id)
    and (new.from_state is not null or new.to_state <> 'candidate');
  select raise(abort, 'from_state must be the current lifecycle')
  where new.from_state is not (select lifecycle from unit where id = new.unit_id)
    and exists (select 1 from unit_state where unit_id = new.unit_id);
  -- A successor's state is read from its history, not its lifecycle column: a row written in the same statement may not be applied yet
  select raise(abort, 'not a lifecycle change a unit can make: withdrawn is final, and a superseded unit only returns to candidate once every successor is withdrawn')
  where exists (select 1 from unit_state where unit_id = new.unit_id) and not (
    (new.from_state = 'candidate' and new.to_state in ('active', 'superseded', 'withdrawn'))
    or (new.from_state = 'active' and new.to_state in ('candidate', 'superseded', 'withdrawn'))
    or (new.from_state = 'superseded' and new.to_state = 'candidate' and not exists (
      select 1 from unit_link l where l.to_unit = new.unit_id and l.kind = 'supersedes'
        and (select to_state from unit_state where unit_id = l.from_unit order by id desc limit 1) is not 'withdrawn')));
  select raise(abort, 'a quarantined or unsourced unit cannot become active')
  where new.to_state = 'active' and exists (select 1 from unit where id = new.unit_id and (extraction <> 'supported' or unsourced = 1));
  select raise(abort, (select missing from unit_support where unit_id = new.unit_id))
  where new.to_state = 'active' and (select missing from unit_support where unit_id = new.unit_id) is not null;
  -- A reconsider condition is the owner's: each needs a quote of the owner, written when the unit is saved. A quote retracted later, or
  -- forgotten (forget's recheck is exempt, since the row is gone), leaves the unit as it was, and readers show the condition as unsupported
  select raise(abort, 'a reconsider condition needs a quote of the owner')
  where new.to_state = 'active' and new.forget_id is null and exists (select 1 from unit_option o where o.unit_id = new.unit_id
    and o.reconsider_when is not null and not exists (select 1 from unit_evidence e join source s on s.id = e.source_id
      where e.option_id = o.id and e.role = 'reconsiders' and s.author_kind = 'owner'));
  select raise(abort, 'superseded needs a supersedes link from an active successor')
  where new.to_state = 'superseded' and not exists (select 1 from unit_link l join unit s on s.id = l.from_unit
    where l.to_unit = new.unit_id and l.kind = 'supersedes' and s.lifecycle = 'active');
end;
-- The one update allowed is the foreign key action clearing source_id after its source was forgotten
create trigger unit_state_append_only before update on unit_state
when not (new.source_id is null and old.source_id is not null and not exists (select 1 from source where id = old.source_id)
  and new.id is old.id and new.unit_id is old.unit_id and new.from_state is old.from_state and new.to_state is old.to_state
  and new.at is old.at and new.reason is old.reason and new.run_id is old.run_id and new.forget_id is old.forget_id) begin
  select raise(abort, 'state history is append-only');
end;
create trigger unit_state_no_delete before delete on unit_state when exists (select 1 from unit where id = old.unit_id) begin
  select raise(abort, 'state history is append-only');
end;
create trigger unit_state_apply after insert on unit_state begin
  update unit set lifecycle = new.to_state, revision = revision + 1 where id = new.unit_id;
end;

-- Where a unit applies in code, or code cited as evidence. Validated against the working tree when served, never cached here.
create table unit_anchor (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  path text not null check (path <> '' and path not glob '/*' and path not glob '*[/]..[/]*' and path not glob '..[/]*'
    and path not glob '*[/]..' and path <> '..' and path not glob '*\*' and path not glob '[A-Za-z]:*'),
  symbol text,
  commit_sha text check (commit_sha is null or (length(commit_sha) = 40 and commit_sha not glob '*[^0-9a-f]*')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end >= line_start),
  excerpt text,
  role text not null check (role in ('applies_to', 'evidence')),
  -- For work recorded before a commit: the edit observation of this path in the session, checked against the working tree when saved
  edit_observation_id integer references edit_observation (id),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  retired_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) is retired_at),
  replaced_by integer references unit_anchor (id)
) strict;
create index unit_anchor_path on unit_anchor (path, role) where retired_at is null;
create index unit_anchor_unit on unit_anchor (unit_id, retired_at);
create index unit_anchor_observation on unit_anchor (edit_observation_id) where edit_observation_id is not null;
create index unit_anchor_replaced on unit_anchor (replaced_by) where replaced_by is not null;
create index unit_anchor_run on unit_anchor (run_id);
-- Anchors are retired and replaced, never edited in place (except setting retired_at and replaced_by once)
create trigger unit_anchor_frozen before update on unit_anchor begin
  select raise(abort, 'anchors are replaced, not edited; retirement happens once')
  where new.unit_id is not old.unit_id or new.path is not old.path or new.symbol is not old.symbol or new.commit_sha is not old.commit_sha
    or new.line_start is not old.line_start or new.line_end is not old.line_end or new.excerpt is not old.excerpt or new.role is not old.role
    or new.edit_observation_id is not old.edit_observation_id or new.run_id is not old.run_id or new.added_at is not old.added_at
    or old.retired_at is not null or new.retired_at is null;
end;
create trigger unit_anchor_no_delete before delete on unit_anchor when exists (select 1 from unit where id = old.unit_id) begin
  select raise(abort, 'anchors are retired, never deleted');
end;

-- What an active unit must have, in one place: missing says what it lacks, and is null when it lacks nothing. Activating reads it, and so
-- does every change that can take support away (a retraction, retiring an anchor), so the two never disagree.
-- Evidence on an option supports the option, never the unit.
create view unit_support as
select u.id as unit_id, case
  when u.kind in ('decision', 'constraint') and (
    not exists (select 1 from unit_evidence e where e.unit_id = u.id and e.option_id is null and e.retracted_at is null)
    or not exists (select 1 from unit_adoption a where a.unit_id = u.id and a.retracted_at is null))
    then 'an active decision or constraint needs unretracted evidence and adoption'
  when u.kind = 'implementation' and not (
    exists (select 1 from unit_evidence e join source s on s.id = e.source_id where e.unit_id = u.id and e.option_id is null
      and e.retracted_at is null and e.role = 'implements' and s.kind in ('commit_message', 'file_excerpt'))
    or exists (select 1 from unit_anchor a where a.unit_id = u.id and a.retired_at is null and a.role = 'evidence'
      and (a.commit_sha is not null or (a.edit_observation_id is not null and exists (select 1 from unit_evidence e
        join source s on s.id = e.source_id join edit_observation o on o.id = a.edit_observation_id
        where e.unit_id = u.id and e.option_id is null and e.retracted_at is null and e.role = 'implements'
          and s.session_id = o.session_id)))))
    then 'an active implementation needs code or commit evidence'
  when u.kind in ('finding', 'dead_end', 'question')
    and not exists (select 1 from unit_evidence e where e.unit_id = u.id and e.option_id is null and e.retracted_at is null)
    then 'an active unit needs unretracted evidence'
end as missing
from unit u;

-- Search-only aliases in Japanese and English, written by the agent with the unit. Each set is bound to the unit's content_hash when written;
-- only the newest set whose hash matches is indexed. Older sets stay for as-of snapshots. Never evidence, never shown as something said.
create table unit_alias (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  terms text not null check (json_valid(terms) and json_type(terms) = 'array' and json_array_length(terms) between 0 and 12),
  content_hash blob not null check (length(content_hash) = 32),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at)
) strict;
create index unit_alias_unit on unit_alias (unit_id, id);
create index unit_alias_run on unit_alias (run_id);
create trigger unit_alias_terms before insert on unit_alias begin
  select raise(abort, 'each alias is a non-empty string of at most 40 characters')
  where exists (select 1 from json_each(new.terms) where type <> 'text' or length(trim(value)) = 0 or length(value) > 40);
end;
create trigger unit_alias_frozen before update on unit_alias begin
  select raise(abort, 'alias sets are replaced by a newer set, not edited');
end;
create trigger unit_alias_no_delete before delete on unit_alias when exists (select 1 from unit where id = old.unit_id) begin
  select raise(abort, 'alias sets are append-only; write an empty set to clear');
end;

-- A field the owner defined for this project's records (a time-boxed trial: kept only if values prove useful in search and reading). Written by trace, quoting the owner's words.
-- A name is defined once per project: redefinition is refused until the trial shows fields are worth keeping.
-- Forgetting the quoted source removes the definition and every value of it.
create table field_def (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  name text not null check (length(name) between 1 and 40 and name glob '[a-z]*' and name not glob '*[^a-z0-9_]*'),
  type text not null check (type in ('text', 'enum', 'integer', 'date')),
  label text not null check (label <> '' and length(label) <= 100),
  description text not null check (description <> '' and length(description) <= 500),
  -- For an enum, its values (1 to 30 distinct non-empty strings of at most 100 characters)
  enum_values text check (enum_values is null or (json_valid(enum_values) and json_type(enum_values) = 'array'
    and json_array_length(enum_values) between 1 and 30)),
  -- The unit kinds the field applies to; empty means every kind
  kinds text not null default '[]' check (json_valid(kinds) and json_type(kinds) = 'array'),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  unique (project_id, name),
  check ((type = 'enum') = (enum_values is not null))
) strict;
create index field_def_source on field_def (source_id);
create index field_def_run on field_def (run_id);
create trigger field_def_check before insert on field_def begin
  select raise(abort, 'a field definition, its source, and its run belong to one project')
  where new.project_id is not (select project_id from source where id = new.source_id)
     or new.project_id is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'fields are defined by trace')
  where (select origin from extraction_run where id = new.run_id) is not 'trace';
  select raise(abort, 'a field definition quotes the owner')
  where not exists (select 1 from source where id = new.source_id and author_kind = 'owner');
  select raise(abort, 'field definition span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  select raise(abort, 'enum values are distinct non-empty strings of at most 100 characters')
  where new.enum_values is not null and (exists (select 1 from json_each(new.enum_values)
      where type <> 'text' or length(trim(value)) = 0 or length(value) > 100)
    or (select count(distinct value) from json_each(new.enum_values)) <> json_array_length(new.enum_values));
  select raise(abort, 'field kinds are distinct unit kinds')
  where exists (select 1 from json_each(new.kinds) where type <> 'text'
      or value not in ('decision', 'implementation', 'finding', 'dead_end', 'question', 'constraint'))
    or (select count(distinct value) from json_each(new.kinds)) <> json_array_length(new.kinds);
end;
create trigger field_def_frozen before update on field_def begin
  select raise(abort, 'field definitions are never rewritten');
end;
create trigger field_def_no_delete before delete on field_def
when exists (select 1 from project where id = old.project_id) and exists (select 1 from source where id = old.source_id) begin
  select raise(abort, 'field definitions are removed only with their quoted source');
end;

-- A unit's value for a field, quoting where it was said. Written with the unit, before its first state, like its options; never rewritten.
-- Forgetting the quoted source (or the definition's) removes the value.
create table unit_field (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  field_def_id integer not null references field_def (id) on delete cascade,
  value text not null check (value <> '' and length(value) <= 200),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  unique (unit_id, field_def_id)
) strict;
create index unit_field_def on unit_field (field_def_id);
create index unit_field_source on unit_field (source_id);
create index unit_field_run on unit_field (run_id);
create trigger unit_field_check before insert on unit_field begin
  select raise(abort, 'a field value, its unit, definition, source, and run belong to one project')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from field_def where id = new.field_def_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'field values are written by trace')
  where (select origin from extraction_run where id = new.run_id) is not 'trace';
  select raise(abort, 'field values are written with the unit, before its first state; record a successor instead')
  where exists (select 1 from unit_state where unit_id = new.unit_id) or exists (select 1 from unit_alias where unit_id = new.unit_id);
  select raise(abort, 'field value span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  select raise(abort, 'the field does not apply to this kind of unit')
  where exists (select 1 from field_def d where d.id = new.field_def_id and json_array_length(d.kinds) > 0
    and not exists (select 1 from json_each(d.kinds) j where j.value = (select kind from unit where id = new.unit_id)));
  select raise(abort, 'an integer field value is an optional minus sign and digits')
  where (select type from field_def where id = new.field_def_id) = 'integer'
    and (new.value not glob '[0-9]*' and new.value not glob '-[0-9]*' or substr(new.value, 2) glob '*[^0-9]*');
  select raise(abort, 'a date field value is a valid YYYY-MM-DD date')
  where (select type from field_def where id = new.field_def_id) = 'date'
    and (length(new.value) <> 10 or date(new.value) is not new.value);
  select raise(abort, 'an enum field value is one of its values')
  where (select type from field_def where id = new.field_def_id) = 'enum' and not exists (select 1 from json_each(
    (select enum_values from field_def where id = new.field_def_id)) where value = new.value);
end;
create trigger unit_field_frozen before update on unit_field begin
  select raise(abort, 'field values are never rewritten; record a successor');
end;
create trigger unit_field_no_delete before delete on unit_field
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and exists (select 1 from field_def where id = old.field_def_id) begin
  select raise(abort, 'field values are removed only with their unit or a quoted source');
end;

-- Cross-project and span checks for everything that points at a unit, a source, or a run
create trigger unit_evidence_check before insert on unit_evidence begin
  select raise(abort, 'evidence and unit belong to different projects')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'evidence span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  select raise(abort, 'a reported speaker is the owner reporting someone else, so it must cite an owner session message')
  where new.reported_speaker is not null and (trim(new.reported_speaker) = '' or not exists (select 1 from source
    where id = new.source_id and kind = 'session_message' and author_kind = 'owner'));
  select raise(abort, 'reconsiders quotes the owner on a rejected option that has a reconsider condition')
  where new.role = 'reconsiders' and (new.option_id is null
    or not exists (select 1 from unit_option where id = new.option_id and reconsider_when is not null)
    or not exists (select 1 from source where id = new.source_id and author_kind = 'owner'));
end;
create trigger unit_evidence_retract before update on unit_evidence begin
  select raise(abort, 'evidence is only ever retracted, once')
  where old.retracted_at is not null or new.unit_id is not old.unit_id or new.option_id is not old.option_id
    or new.source_id is not old.source_id or new.span_start is not old.span_start or new.span_end is not old.span_end
    or new.role is not old.role or new.reported_speaker is not old.reported_speaker or new.run_id is not old.run_id
    or new.added_at is not old.added_at or new.retracted_at is null;
  select raise(abort, 'the retraction must cite an owner span of the same project')
  where not exists (select 1 from source s where s.id = new.retraction_source_id and s.author_kind = 'owner'
    and s.project_id = (select project_id from unit where id = new.unit_id)
    and new.retraction_span_end <= length(cast(s.text as blob)));
end;
-- Deleting a project (or its unit or source) cascades; only a direct delete of a live link is refused.
-- A retracted row whose retraction reason cites a forgotten source is removed with that source (the reason cannot outlive it).
create trigger unit_evidence_no_delete before delete on unit_evidence
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and not (old.retracted_at is not null and exists (select 1 from source_forgotten where source_id = old.retraction_source_id)) begin
  select raise(abort, 'evidence is retracted, never deleted');
end;
create trigger unit_adoption_no_delete before delete on unit_adoption
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and not (old.retracted_at is not null and exists (select 1 from source_forgotten where source_id = old.retraction_source_id)) begin
  select raise(abort, 'adoption is retracted, never deleted');
end;
-- A retraction, or retiring an anchor, that would leave an active unit without its required support must first move it back to candidate
create trigger unit_evidence_retract_support after update of retracted_at on unit_evidence
when exists (select 1 from unit u join unit_support s on s.unit_id = u.id
  where u.id = new.unit_id and u.lifecycle = 'active' and s.missing is not null) begin
  select raise(abort, 'move the unit back to candidate before retracting its last evidence');
end;
create trigger unit_adoption_retract_support after update of retracted_at on unit_adoption
when exists (select 1 from unit u join unit_support s on s.unit_id = u.id
  where u.id = new.unit_id and u.lifecycle = 'active' and s.missing is not null) begin
  select raise(abort, 'move the unit back to candidate before retracting its last adoption');
end;
create trigger unit_anchor_retire_support after update of retired_at on unit_anchor
when exists (select 1 from unit u join unit_support s on s.unit_id = u.id
  where u.id = new.unit_id and u.lifecycle = 'active' and s.missing is not null) begin
  select raise(abort, 'move the unit back to candidate before retiring its last code anchor');
end;
create trigger unit_adoption_check before insert on unit_adoption begin
  select raise(abort, 'adoption and unit belong to different projects')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'adoption span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
end;
create trigger unit_adoption_retract before update on unit_adoption begin
  select raise(abort, 'adoption is only ever retracted, once')
  where old.retracted_at is not null or new.unit_id is not old.unit_id or new.route is not old.route
    or new.source_id is not old.source_id or new.span_start is not old.span_start or new.span_end is not old.span_end
    or new.run_id is not old.run_id or new.added_at is not old.added_at or new.retracted_at is null;
  select raise(abort, 'the retraction must cite an owner span of the same project')
  where not exists (select 1 from source s where s.id = new.retraction_source_id and s.author_kind = 'owner'
    and s.project_id = (select project_id from unit where id = new.unit_id)
    and new.retraction_span_end <= length(cast(s.text as blob)));
end;
create trigger unit_link_check before insert on unit_link begin
  select raise(abort, 'linked units belong to different projects')
  where (select project_id from unit where id = new.from_unit) is not (select project_id from unit where id = new.to_unit)
     or (select project_id from unit where id = new.from_unit) is not (select project_id from extraction_run where id = new.run_id);
end;
create trigger unit_state_project before insert on unit_state begin
  select raise(abort, 'state and unit belong to different projects')
  where (new.run_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id))
     or (new.forget_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from forget_batch where id = new.forget_id))
     or (new.source_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id));
end;
create trigger unit_anchor_project before insert on unit_anchor begin
  select raise(abort, 'anchor and unit belong to different projects')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'the edit observation must be of this path in a session of the same project')
  where new.edit_observation_id is not null and not exists (select 1 from edit_observation o join session s on s.id = o.session_id
    where o.id = new.edit_observation_id and o.path = new.path and s.project_id = (select project_id from unit where id = new.unit_id));
end;
create trigger unit_alias_project before insert on unit_alias begin
  select raise(abort, 'alias and unit belong to different projects')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
end;
create trigger source_processing_project before insert on source_processing begin
  select raise(abort, 'source and run belong to different projects')
  where (select project_id from source where id = new.source_id) is not (select project_id from extraction_run where id = new.run_id);
end;
create trigger external_reference_check before insert on external_reference begin
  select raise(abort, 'an external reference needs an owner span of the same project')
  where not exists (select 1 from source s where s.id = new.owner_source_id and s.author_kind = 'owner' and s.project_id = new.project_id
    and new.span_end <= length(cast(s.text as blob)));
end;

-- Every change to a unit's relations raises its revision (stale drafts are refused against it)
create trigger unit_rev_evidence_i after insert on unit_evidence begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_evidence_u after update on unit_evidence begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_adoption_i after insert on unit_adoption begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_adoption_u after update on unit_adoption begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_evidence_d after delete on unit_evidence when exists (select 1 from unit where id = old.unit_id) begin
  update unit set revision = revision + 1 where id = old.unit_id;
end;
create trigger unit_rev_adoption_d after delete on unit_adoption when exists (select 1 from unit where id = old.unit_id) begin
  update unit set revision = revision + 1 where id = old.unit_id;
end;
create trigger unit_rev_link_i after insert on unit_link begin
  update unit set revision = revision + 1 where id in (new.from_unit, new.to_unit);
end;
create trigger unit_rev_link_u after update on unit_link begin
  update unit set revision = revision + 1 where id in (new.from_unit, new.to_unit);
end;
create trigger unit_rev_anchor_i after insert on unit_anchor begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_anchor_u after update on unit_anchor begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_alias_i after insert on unit_alias begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_field_i after insert on unit_field begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_field_d after delete on unit_field when exists (select 1 from unit where id = old.unit_id) begin
  update unit set revision = revision + 1 where id = old.unit_id;
end;

-- Unit search text: body (text, reason, scope, revisit condition, options and their reconsider conditions, field names and values), identifiers (live anchors), and the newest matching alias set.
-- search.ts weighs body and identifiers above aliases. Lifecycle is not indexed; queries filter it.
create view unit_search_text as
select u.id,
  sphica_terms(u.text || char(10) || coalesce(u.why, '') || char(10) || coalesce(u.scope_note, '') || char(10)
    || coalesce(u.revisit_when, '') || char(10)
    || coalesce((select group_concat(o.text || ' ' || coalesce(o.why, '') || ' ' || coalesce(o.reconsider_when, ''), char(10))
      from (select text, why, reconsider_when from unit_option where unit_id = u.id order by position) o), '') || char(10)
    || coalesce((select group_concat(f.name || ' ' || f.value, char(10))
      from (select d.name, v.value from unit_field v join field_def d on d.id = v.field_def_id where v.unit_id = u.id order by v.id) f), ''))
    as body,
  sphica_terms(coalesce((select group_concat(a.path || ' ' || coalesce(a.symbol, ''), char(10))
    from (select path, symbol from unit_anchor where unit_id = u.id and retired_at is null order by id) a), '')) as ident,
  sphica_terms(coalesce((select group_concat(j.value, ' ')
    from json_each((select terms from unit_alias where unit_id = u.id and content_hash = u.content_hash order by id desc limit 1)) j), ''))
    as alias
from unit u;
create virtual table unit_fts using fts5(body, ident, alias, content='', contentless_delete=1);
create trigger unit_fts_ai after insert on unit begin
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.id;
end;
create trigger unit_fts_ad after delete on unit begin
  delete from unit_fts where rowid = old.id;
end;
-- Children are written after the unit in the same transaction; every child change reindexes its unit
create trigger unit_fts_option_i after insert on unit_option begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_anchor_i after insert on unit_anchor begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_anchor_u after update on unit_anchor begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_anchor_d after delete on unit_anchor when exists (select 1 from unit where id = old.unit_id) begin
  delete from unit_fts where rowid = old.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = old.unit_id;
end;
create trigger unit_fts_alias_i after insert on unit_alias begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_alias_d after delete on unit_alias when exists (select 1 from unit where id = old.unit_id) begin
  delete from unit_fts where rowid = old.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = old.unit_id;
end;
create trigger unit_fts_field_i after insert on unit_field begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_field_d after delete on unit_field when exists (select 1 from unit where id = old.unit_id) begin
  delete from unit_fts where rowid = old.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = old.unit_id;
end;

-- Current work status, updated by trace
create table work (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  key text not null,
  title text not null check (title <> ''),
  goal text not null check (goal <> ''),
  current text not null check (current <> ''),
  next text not null default '[]' check (json_valid(next) and json_type(next) = 'array'),
  status text not null check (status in ('active', 'blocked', 'paused', 'done', 'abandoned')),
  branch text,
  run_id integer references extraction_run (id),
  updated_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) is updated_at),
  unique (project_id, key)
) strict;
create index work_open on work (project_id, updated_at desc) where status in ('active', 'blocked', 'paused');
create index work_run on work (run_id) where run_id is not null;

-- What a delivery hook emitted or suppressed, and how many eligible units it left out. No source text is copied here.
-- chars is the delivered length without the omission note (Sphica's own text), since the read budget adds it up.
create table delivery (
  id integer primary key autoincrement not null,
  session_id text references session (id) on delete cascade,
  event text not null check (event in ('session_start', 'pre_edit', 'pre_read', 'prompt', 'review')),
  outcome text not null check (outcome in ('emitted', 'nothing', 'unavailable', 'suppressed')),
  reason text,
  path text,
  eligible integer not null default 0 check (eligible >= 0),
  omitted integer not null default 0 check (omitted >= 0 and omitted <= eligible),
  chars integer not null default 0 check (chars >= 0),
  at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', at) is at)
) strict;
create index delivery_session on delivery (session_id, at);
create table delivery_unit (
  delivery_id integer not null references delivery (id) on delete cascade,
  unit_id integer not null references unit (id) on delete cascade,
  primary key (delivery_id, unit_id)
) strict;
create index delivery_unit_unit on delivery_unit (unit_id);

-- The views the capture connection may write. The capture authorizer allows inserts into these views only; the triggers derive
-- project, artifact, and indexing from the session and the speaker, so capture cannot write another project's rows or third-party text.
create view capture_session as select id, project_id, host, external_id, branch, started_at from session;
create trigger capture_session_insert instead of insert on capture_session begin
  select raise(abort, 'the session already exists with different details')
  where exists (select 1 from session where id = new.id and (project_id <> new.project_id or host <> new.host or external_id <> new.external_id));
  insert into session (id, project_id, host, external_id, branch, started_at)
  select new.id, new.project_id, new.host, new.external_id, new.branch, new.started_at
  where not exists (select 1 from session where id = new.id);
end;
-- speaker: owner (the host's user typed it or answered AskUserQuestion) or assistant (the host's final reply, or the questions it asked)
create view capture_message as
  select external_id, session_id, turn_id, author_kind as speaker, created_at, captured_at, text, truncated, redacted, original_bytes,
    content_hash from source where kind = 'session_message';
create trigger capture_message_insert instead of insert on capture_message begin
  select raise(abort, 'unknown session') where not exists (select 1 from session where id = new.session_id);
  select raise(abort, 'speaker must be owner or assistant') where new.speaker not in ('owner', 'assistant');
  select raise(abort, 'the message already exists with different content')
  where exists (select 1 from source where kind = 'session_message' and session_id = new.session_id and external_id = new.external_id
    and (text is not new.text or author_kind is not new.speaker or turn_id is not new.turn_id or created_at is not new.created_at
      or truncated is not new.truncated or redacted is not new.redacted or original_bytes is not new.original_bytes
      or content_hash is not new.content_hash));
  insert into source (project_id, kind, artifact, external_id, revision, session_id, turn_id, author_kind, created_at, available_at,
    captured_at, text, truncated, redacted, original_bytes, content_hash, indexed)
  select s.project_id, 'session_message', 'session:' || s.id, new.external_id, 1, s.id, new.turn_id, new.speaker, new.created_at,
    new.created_at, new.captured_at, new.text, new.truncated, new.redacted, new.original_bytes, new.content_hash,
    new.speaker = 'owner'
  from session s where s.id = new.session_id
    and not exists (select 1 from source where kind = 'session_message' and session_id = new.session_id and external_id = new.external_id)
    and not exists (select 1 from source_forgotten f where f.project_id = s.project_id and f.artifact = 'session:' || s.id
      and f.kind = 'session_message' and f.external_id = new.external_id and f.content_hash = new.content_hash);
end;
create view capture_edit as select session_id, turn_id, tool_event_id, path, via, observed_at from edit_observation;
create trigger capture_edit_insert instead of insert on capture_edit begin
  insert into edit_observation (session_id, turn_id, tool_event_id, path, via, observed_at)
  select new.session_id, new.turn_id, new.tool_event_id, new.path, new.via, new.observed_at
  where exists (select 1 from session where id = new.session_id) on conflict do nothing;
end;
-- units is a JSON array of the unit ids delivered; each must belong to the delivered session's project
create view capture_delivery as
  select session_id, event, outcome, reason, path, eligible, omitted, chars, at, null as units from delivery;
create trigger capture_delivery_insert instead of insert on capture_delivery begin
  select raise(abort, 'the unit and the delivered session belong to different projects')
  where exists (select 1 from json_each(coalesce(new.units, '[]')) j
    where (select project_id from unit where id = j.value) is not (select project_id from session where id = new.session_id));
  insert into delivery (session_id, event, outcome, reason, path, eligible, omitted, chars, at)
  values (new.session_id, new.event, new.outcome, new.reason, new.path, coalesce(new.eligible, 0), coalesce(new.omitted, 0),
    coalesce(new.chars, 0), new.at);
  insert into delivery_unit (delivery_id, unit_id)
  select last_insert_rowid(), j.value from json_each(coalesce(new.units, '[]')) j where true on conflict do nothing;
end;

pragma user_version = 5;
