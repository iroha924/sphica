-- Revision 9 → 10 of generation 2: AI adoption. Evidence gains the role decides and adoption the route agent; each record tool call is
-- logged (record_call), Claude Code's PreToolUse hook logs the turn of each (tool_call_observation), and a run names the call that began it.
-- Triggers and views are dropped first and all created again: rebuilding a table fails while a trigger names it.
-- Every statement matches db/schema.sql at revision 10; server/test/migrate.test.ts compares a migrated database with a fresh one.

drop trigger project_key_normal_insert;
drop trigger project_key_normal_update;
drop trigger source_owner_bound;
drop trigger session_cited;
drop trigger source_session_project;
drop trigger source_no_update;
drop trigger source_fts_ai;
drop trigger source_fts_ad;
drop trigger extraction_run_frozen;
drop trigger unit_insert_candidate;
drop trigger unit_run_project;
drop trigger unit_text_frozen;
drop trigger unit_revision_step;
drop trigger unit_lifecycle_via_state;
drop trigger unit_option_sealed;
drop trigger unit_option_frozen;
drop trigger unit_option_no_delete;
drop trigger unit_adoption_route;
drop trigger unit_link_frozen;
drop trigger unit_link_no_delete;
drop trigger unit_link_supersedes_acyclic;
drop trigger unit_state_rules;
drop trigger unit_state_append_only;
drop trigger unit_state_no_delete;
drop trigger unit_state_apply;
drop trigger unit_state_restore;
drop trigger unit_anchor_frozen;
drop trigger unit_anchor_no_delete;
drop trigger unit_alias_terms;
drop trigger unit_alias_frozen;
drop trigger unit_alias_no_delete;
drop trigger field_def_check;
drop trigger field_def_frozen;
drop trigger field_def_no_delete;
drop trigger unit_field_check;
drop trigger unit_field_frozen;
drop trigger unit_field_no_delete;
drop trigger unit_evidence_check;
drop trigger unit_evidence_retract;
drop trigger unit_evidence_no_delete;
drop trigger unit_adoption_no_delete;
drop trigger unit_evidence_retract_support;
drop trigger unit_adoption_retract_support;
drop trigger unit_anchor_retire_support;
drop trigger unit_adoption_check;
drop trigger unit_adoption_retract;
drop trigger unit_link_check;
drop trigger unit_state_project;
drop trigger unit_anchor_project;
drop trigger unit_alias_project;
drop trigger source_processing_project;
drop trigger unit_rev_evidence_i;
drop trigger unit_rev_evidence_u;
drop trigger unit_rev_adoption_i;
drop trigger unit_rev_adoption_u;
drop trigger unit_rev_evidence_d;
drop trigger unit_rev_adoption_d;
drop trigger unit_rev_link_i;
drop trigger unit_rev_link_u;
drop trigger unit_rev_anchor_i;
drop trigger unit_rev_anchor_u;
drop trigger unit_rev_alias_i;
drop trigger unit_rev_field_i;
drop trigger unit_rev_field_d;
drop trigger unit_fts_ai;
drop trigger unit_fts_ad;
drop trigger unit_fts_option_i;
drop trigger unit_fts_anchor_i;
drop trigger unit_fts_anchor_u;
drop trigger unit_fts_anchor_d;
drop trigger unit_fts_alias_i;
drop trigger unit_fts_alias_d;
drop trigger unit_fts_field_i;
drop trigger unit_fts_field_d;
drop trigger delivery_ad;
drop trigger ingest_source_insert;
drop trigger capture_session_insert;
drop trigger capture_message_insert;
drop trigger capture_edit_insert;
drop trigger capture_delivery_insert;
drop trigger capture_delivery_scoped_insert;
drop trigger capture_delivery_prune_insert;
drop view unit_support;
drop view unit_search_text;
drop view ingest_source;
drop view capture_session;
drop view capture_message;
drop view capture_edit;
drop view capture_delivery;
drop view capture_delivery_scoped;
drop view capture_delivery_prune;

create temp table sphica_migration_seq as select name, seq from sqlite_sequence where name in ('extraction_run', 'unit_evidence', 'unit_adoption');

create table record_call (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  tool text not null check (tool <> ''),
  host text check (host in ('claude-code', 'codex')),
  caller_session text,
  caller_turn text,
  tool_use_id text,
  mode text not null check (mode in ('interactive', 'headless', 'sdk', 'unknown')),
  mode_raw text,
  called_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', called_at) is called_at)
) strict;
create table tool_call_observation (
  id integer primary key autoincrement not null,
  host text not null check (host in ('claude-code', 'codex')),
  session_external text not null check (session_external <> ''),
  turn_id text,
  tool_use_id text not null check (tool_use_id <> ''),
  tool_name text not null check (tool_name <> ''),
  owner_turn integer not null check (owner_turn in (0, 1)),
  observed_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) is observed_at),
  unique (host, tool_use_id)
) strict;
create table unit_replacement (
  id integer primary key autoincrement not null,
  from_unit integer not null references unit (id) on delete cascade,
  to_unit integer not null references unit (id) on delete cascade,
  run_id integer references extraction_run (id),
  forget_id integer references forget_batch (id),
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  ended_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) is ended_at),
  end_reason text,
  end_run_id integer references extraction_run (id),
  end_forget_id integer references forget_batch (id),
  check ((run_id is null) <> (forget_id is null)),
  check ((ended_at is null) = (end_reason is null)),
  check (ended_at is null or (end_run_id is null) <> (end_forget_id is null)),
  check (ended_at is not null or (end_run_id is null and end_forget_id is null)),
  check (ended_at >= started_at),
  check (from_unit <> to_unit)
) strict;
create table unit_replacement_gap (
  from_unit integer not null references unit (id) on delete cascade,
  to_unit integer not null references unit (id) on delete cascade,
  run_id integer not null references extraction_run (id),
  primary key (from_unit, to_unit)
) strict;

create table extraction_run_new (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  origin text not null check (origin in ('trace', 'harvest', 'glean', 'migration')),
  target text not null,
  session_id text references session (id) on delete set null,
  status text not null check (status in ('running', 'saved')),
  input_bytes integer check (input_bytes >= 0),
  -- The CLI-issued draft this run saves. A saved run's draft saves nothing again; the draft is bound to this run's project and target
  draft_id text unique,
  -- The record tool call that began this run; save compares its own caller with it
  begin_call_id integer references record_call (id),
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  finished_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) is finished_at),
  check (finished_at >= started_at)
) strict;
insert into extraction_run_new (id, project_id, origin, target, session_id, status, input_bytes, draft_id, started_at, finished_at) select id, project_id, origin, target, session_id, status, input_bytes, draft_id, started_at, finished_at from extraction_run;
drop table extraction_run;
alter table extraction_run_new rename to extraction_run;

create table unit_evidence_new (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  option_id integer,
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  role text not null check (role in ('states', 'proposes', 'rejects', 'explains', 'implements', 'reconsiders', 'decides')),
  -- A third party the owner reported ("X said ..."): hearsay by the owner, never X's own statement
  reported_speaker text,
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  retracted_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', retracted_at) is retracted_at),
  retraction_reason text,
  retraction_source_id integer references source (id) on delete cascade,
  retraction_span_start integer,
  retraction_span_end integer,
  foreign key (unit_id, option_id) references unit_option (unit_id, id) on delete cascade,
  check ((retracted_at is null) = (retraction_reason is null)),
  check ((retracted_at is null) = (retraction_source_id is null)),
  check ((retraction_source_id is null) = (retraction_span_start is null)),
  check ((retraction_source_id is null) = (retraction_span_end is null)),
  check (retraction_span_end is null or retraction_span_end > retraction_span_start),
  check (retraction_span_start >= 0),
  check (retracted_at >= added_at)
) strict;
insert into unit_evidence_new (id, unit_id, option_id, source_id, span_start, span_end, role, reported_speaker, run_id, added_at, retracted_at, retraction_reason, retraction_source_id, retraction_span_start, retraction_span_end) select id, unit_id, option_id, source_id, span_start, span_end, role, reported_speaker, run_id, added_at, retracted_at, retraction_reason, retraction_source_id, retraction_span_start, retraction_span_end from unit_evidence;
drop table unit_evidence;
alter table unit_evidence_new rename to unit_evidence;

create table unit_adoption_new (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  route text not null check (route in ('owner_statement', 'explicit', 'agent')),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  retracted_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', retracted_at) is retracted_at),
  retraction_reason text,
  retraction_source_id integer references source (id) on delete cascade,
  retraction_span_start integer,
  retraction_span_end integer,
  unique (unit_id, source_id, span_start, span_end),
  check ((retracted_at is null) = (retraction_reason is null)),
  check ((retracted_at is null) = (retraction_source_id is null)),
  check ((retraction_source_id is null) = (retraction_span_start is null)),
  check ((retraction_source_id is null) = (retraction_span_end is null)),
  check (retraction_span_end is null or retraction_span_end > retraction_span_start),
  check (retraction_span_start >= 0),
  check (retracted_at >= added_at)
) strict;
insert into unit_adoption_new (id, unit_id, route, source_id, span_start, span_end, run_id, added_at, retracted_at, retraction_reason, retraction_source_id, retraction_span_start, retraction_span_end) select id, unit_id, route, source_id, span_start, span_end, run_id, added_at, retracted_at, retraction_reason, retraction_source_id, retraction_span_start, retraction_span_end from unit_adoption;
drop table unit_adoption;
alter table unit_adoption_new rename to unit_adoption;

-- A rebuilt table's counter restarts from its largest copied id; keep the larger of that and the old counter
update sqlite_sequence set seq = max(seq, (select seq from temp.sphica_migration_seq m where m.name = sqlite_sequence.name))
  where name in (select name from temp.sphica_migration_seq);
insert into sqlite_sequence (name, seq) select name, seq from temp.sphica_migration_seq m where not exists (select 1 from sqlite_sequence s where s.name = m.name);
drop table temp.sphica_migration_seq;

-- Replacements from what revision-9 history proves. Every project with records gets a migration run for the rows and states written
-- here and when the step judges every record afterwards (server/src/reconcile.ts settleForMigration).
create temp table sphica_migration_note (rule text, item text, action text);
insert into extraction_run (project_id, origin, target, status, started_at, finished_at)
select distinct project_id, 'migration', 'revision:10', 'saved', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
from unit;
create temp table sphica_migration_run as
select project_id, max(id) as id from extraction_run where origin = 'migration' and target = 'revision:10' group by project_id;

-- In effect now: a superseded record and the live successor revision 9 let hold its one place, from when it was last superseded
insert into unit_replacement (from_unit, to_unit, run_id, started_at)
select l.from_unit, l.to_unit, r.id,
  coalesce((select max(t.at) from unit_state t where t.unit_id = o.id and t.to_state = 'superseded'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
from unit_link l join unit o on o.id = l.to_unit join unit s on s.id = l.from_unit join temp.sphica_migration_run r on r.project_id = o.project_id
where l.kind = 'supersedes' and o.lifecycle = 'superseded' and s.lifecycle in ('active', 'superseded')
  and s.extraction = 'supported' and s.unsourced = 0
  and l.from_unit = (select min(k.from_unit) from unit_link k join unit ks on ks.id = k.from_unit where k.to_unit = o.id
    and k.kind = 'supersedes' and ks.lifecycle in ('active', 'superseded') and ks.extraction = 'supported' and ks.unsourced = 0);
insert into sphica_migration_note
select 'a replacement in effect, dated from when the record was last superseded', s.key || ' → ' || o.key, 'in effect since ' || x.started_at
from unit_replacement x join unit s on s.id = x.from_unit join unit o on o.id = x.to_unit where x.ended_at is null;

-- Ended in the past: the successor in effect (active until then) was withdrawn, which brought the record back at that very moment
-- (revision 9 wrote both together, the withdrawal first). Each restoration pairs with the last such withdrawal before it, and starts at
-- the record's last superseded state before it, by state order: times alone repeat within one millisecond. A proposal withdrawn in the
-- same save was never in effect, so it proves nothing
insert into unit_replacement (from_unit, to_unit, run_id, started_at, ended_at, end_reason, end_run_id)
select l.from_unit, l.to_unit, r.id, b.started, w.at, s.key || ' was withdrawn', r.id
from (select t.id, t.unit_id, t.at,
    (select p.at from unit_state p where p.unit_id = t.unit_id and p.to_state = 'superseded' and p.id < t.id order by p.id desc limit 1) as started,
    (select max(w2.id) from unit_state w2 join unit_link l2 on l2.from_unit = w2.unit_id and l2.to_unit = t.unit_id and l2.kind = 'supersedes'
      where w2.to_state = 'withdrawn' and w2.from_state = 'active' and w2.at = t.at and w2.id < t.id) as cause
  from unit_state t where t.from_state = 'superseded' and t.to_state = 'candidate' and t.reason = 'its successor was withdrawn') b
join unit_state w on w.id = b.cause
join unit_link l on l.from_unit = w.unit_id and l.to_unit = b.unit_id and l.kind = 'supersedes'
join unit s on s.id = l.from_unit join unit o on o.id = l.to_unit
join temp.sphica_migration_run r on r.project_id = o.project_id
where b.started is not null;
insert into sphica_migration_note
select 'a past replacement, proven by the withdrawal that ended it', s.key || ' → ' || o.key, 'from ' || x.started_at || ' to ' || x.ended_at
from unit_replacement x join unit s on s.id = x.from_unit join unit o on o.id = x.to_unit where x.ended_at is not null;

-- An intent whose successor was once active but whose effect no history dates: marked, so read never calls it a mere proposal
insert into unit_replacement_gap (from_unit, to_unit, run_id)
select l.from_unit, l.to_unit, r.id
from unit_link l join unit o on o.id = l.to_unit join temp.sphica_migration_run r on r.project_id = o.project_id
where l.kind = 'supersedes'
  and not exists (select 1 from unit_replacement x where x.from_unit = l.from_unit and x.to_unit = l.to_unit)
  and exists (select 1 from unit_state t where t.unit_id = l.from_unit and t.to_state = 'active');
insert into sphica_migration_note
select 'an intent whose earlier effect is not recorded', s.key || ' → ' || o.key, 'marked: read says its history was not recorded'
from unit_replacement_gap g join unit s on s.id = g.from_unit join unit o on o.id = g.to_unit;
-- Reads now show history these records did not have: a change made against their earlier revision is stale
update unit set revision = revision + 1 where id in (
  select from_unit from unit_replacement union select to_unit from unit_replacement
  union select from_unit from unit_replacement_gap union select to_unit from unit_replacement_gap);
drop table temp.sphica_migration_run;

create index record_call_project on record_call (project_id, host, called_at);
create index record_call_caller on record_call (host, caller_session, caller_turn);
create index record_call_tool_use on record_call (tool_use_id) where tool_use_id is not null;
create index extraction_run_project on extraction_run (project_id);
create index extraction_run_session on extraction_run (session_id) where session_id is not null;
create index extraction_run_begin_call on extraction_run (begin_call_id) where begin_call_id is not null;
create unique index unit_evidence_unit_once on unit_evidence (unit_id, source_id, span_start, span_end, role) where option_id is null;
create unique index unit_evidence_option_once on unit_evidence (option_id, source_id, span_start, span_end, role) where option_id is not null;
create index unit_evidence_source on unit_evidence (source_id);
create index unit_evidence_option on unit_evidence (unit_id, option_id);
create index unit_evidence_retraction on unit_evidence (retraction_source_id) where retraction_source_id is not null;
create index unit_evidence_run on unit_evidence (run_id);
create index unit_adoption_source on unit_adoption (source_id);
create index unit_adoption_retraction on unit_adoption (retraction_source_id) where retraction_source_id is not null;
create index unit_adoption_run on unit_adoption (run_id);
create unique index unit_link_one_intent on unit_link (from_unit) where kind = 'supersedes';
create unique index unit_replacement_place on unit_replacement (to_unit) where ended_at is null;
create index unit_replacement_from on unit_replacement (from_unit);
create index unit_replacement_to on unit_replacement (to_unit);
create index unit_replacement_run on unit_replacement (run_id) where run_id is not null;
create index unit_replacement_forget on unit_replacement (forget_id) where forget_id is not null;
create index unit_replacement_end_run on unit_replacement (end_run_id) where end_run_id is not null;
create index unit_replacement_end_forget on unit_replacement (end_forget_id) where end_forget_id is not null;
create index unit_replacement_gap_to on unit_replacement_gap (to_unit);
create index unit_replacement_gap_run on unit_replacement_gap (run_id);
create trigger project_key_normal_insert before insert on project when new.key glob 'git:*' begin
  select raise(abort, 'the project key is not normalized')
  from (select rest, case when instr(rest, '/') = 0 then rest else substr(rest, 1, instr(rest, '/') - 1) end as host
    from (select substr(new.key, 5) as rest))
  where new.key is not case when lower(host) = 'github.com' then lower(new.key) else 'git:' || lower(host) || substr(rest, length(host) + 1) end;
end;
create trigger project_key_normal_update before update of key on project when new.key glob 'git:*' begin
  select raise(abort, 'the project key is not normalized')
  from (select rest, case when instr(rest, '/') = 0 then rest else substr(rest, 1, instr(rest, '/') - 1) end as host
    from (select substr(new.key, 5) as rest))
  where new.key is not case when lower(host) = 'github.com' then lower(new.key) else 'git:' || lower(host) || substr(rest, length(host) + 1) end;
end;
create trigger source_owner_bound before insert on source
when new.kind <> 'session_message' and new.author_kind = 'owner'
  and not exists (select 1 from owner_identity where provider = 'github' and external_id = new.author_external_id) begin
  select raise(abort, 'owner authorship needs a bound owner identity');
end;
create trigger session_cited before delete on session
when exists (select 1 from project where id = old.project_id) and (
  exists (select 1 from source s where s.session_id = old.id and (
    exists (select 1 from unit_evidence e where e.source_id = s.id or e.retraction_source_id = s.id)
    or exists (select 1 from unit_adoption a where a.source_id = s.id or a.retraction_source_id = s.id)
    or exists (select 1 from field_def d where d.source_id = s.id)
    or exists (select 1 from unit_field f where f.source_id = s.id)
    or exists (select 1 from unit_state t where t.source_id = s.id)))
  or exists (select 1 from edit_observation o join unit_anchor a on a.edit_observation_id = o.id where o.session_id = old.id)) begin
  select raise(abort, 'records cite this session; forget its messages with /sphica:forget rather than deleting it');
end;
create trigger source_session_project before insert on source when new.session_id is not null
  and not exists (select 1 from session where id = new.session_id and project_id = new.project_id) begin
  select raise(abort, 'source and session belong to different projects');
end;
create trigger source_no_update before update on source begin
  select raise(abort, 'sources are never rewritten; capture a new revision');
end;
create trigger source_fts_ai after insert on source when new.indexed = 1 begin
  insert into source_fts (rowid, lexemes) values (new.id, sphica_terms(new.text));
end;
create trigger source_fts_ad after delete on source when old.indexed = 1 begin
  delete from source_fts where rowid = old.id;
end;
create trigger record_call_frozen before update on record_call begin
  select raise(abort, 'record tool calls are never changed');
end;
create trigger extraction_run_call_project before insert on extraction_run when new.begin_call_id is not null begin
  select raise(abort, 'a run begins from a record tool call of its own project')
  where (select project_id from record_call where id = new.begin_call_id) is not new.project_id;
end;
create trigger extraction_run_frozen before update on extraction_run
when new.id is not old.id or new.project_id is not old.project_id or new.origin is not old.origin or new.target is not old.target
  or new.input_bytes is not old.input_bytes or new.draft_id is not old.draft_id or new.begin_call_id is not old.begin_call_id
  or new.started_at is not old.started_at
  or (new.session_id is not old.session_id and (new.session_id is not null or exists (select 1 from session where id = old.session_id)))
  or ((new.status is not old.status or new.finished_at is not old.finished_at) and old.status <> 'running') begin
  select raise(abort, 'a run changes once, when it finishes');
end;
create trigger unit_insert_candidate before insert on unit when new.lifecycle <> 'candidate' begin
  select raise(abort, 'units start as candidates');
end;
create trigger unit_run_project before insert on unit
when not exists (select 1 from extraction_run where id = new.run_id and project_id = new.project_id) begin
  select raise(abort, 'unit and run belong to different projects');
end;
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
create trigger unit_adoption_route before insert on unit_adoption begin
  select raise(abort, 'owner_statement adoption needs an owner-authored source')
  where new.route = 'owner_statement' and not exists (select 1 from source where id = new.source_id and author_kind = 'owner');
  select raise(abort, 'explicit adoption needs the owner or a maintainer (OWNER, MEMBER, COLLABORATOR association)')
  where new.route = 'explicit' and not exists (select 1 from source where id = new.source_id
    and (author_kind = 'owner' or author_association in ('OWNER', 'MEMBER', 'COLLABORATOR')));
  select raise(abort, 'a merge is not adoption')
  where exists (select 1 from source where id = new.source_id and kind = 'pr_event');
  select raise(abort, 'adoption applies to decisions and constraints')
  where not exists (select 1 from unit where id = new.unit_id and kind in ('decision', 'constraint'));
  select raise(abort, 'agent adoption pairs with live decides evidence on the same span of the unit')
  where new.route = 'agent' and not exists (select 1 from unit_evidence e where e.unit_id = new.unit_id and e.option_id is null
    and e.role = 'decides' and e.source_id = new.source_id and e.span_start = new.span_start and e.span_end = new.span_end
    and e.retracted_at is null);
  select raise(abort, 'agent adoption needs a trace run')
  where new.route = 'agent' and not exists (select 1 from extraction_run where id = new.run_id and origin = 'trace');
  select raise(abort, 'agent adoption needs a run begun by an interactive session')
  where new.route = 'agent' and not exists (select 1 from extraction_run r join record_call c on c.id = r.begin_call_id
    where r.id = new.run_id and c.mode = 'interactive');
  select raise(abort, 'agent adoption cannot cite a reply from a turn that ran a record tool, or one no record tool call can be placed away from')
  where new.route = 'agent' and exists (select 1 from agent_ineligible_source where source_id = new.source_id);
end;
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
create trigger unit_replacement_check before insert on unit_replacement begin
  select raise(abort, 'a replacement''s cause belongs to the project of the records it joins')
  where exists (select 1 from extraction_run where id = new.run_id
      and project_id is not (select project_id from unit where id = new.to_unit))
    or exists (select 1 from forget_batch where id = new.forget_id
      and project_id is not (select project_id from unit where id = new.to_unit));
  select raise(abort, 'a replacement takes effect only from the record''s own intent to replace that one')
  where not exists (select 1 from unit_link where from_unit = new.from_unit and to_unit = new.to_unit and kind = 'supersedes');
  select raise(abort, 'a replacement starts open')
  where new.ended_at is not null;
  -- A record whose source is gone can be replaced (that is how it is fixed); a quarantined one, never active, cannot
  select raise(abort, 'a replacement takes effect only from a sound successor into a record not quarantined nor withdrawn')
  where exists (select 1 from unit where id = new.from_unit and (extraction <> 'supported' or unsourced = 1 or lifecycle = 'withdrawn'))
    or exists (select 1 from unit where id = new.to_unit and (extraction <> 'supported' or lifecycle = 'withdrawn'));
  -- Of a decision or constraint, only the owner's or a maintainer's adoption lets a replacement take effect, whatever it replaces
  select raise(abort, 'a decision or constraint replaces another only with the owner''s or a maintainer''s adoption')
  where exists (select 1 from unit where id = new.from_unit and kind in ('decision', 'constraint'))
    and not exists (select 1 from unit_adoption where unit_id = new.from_unit and route in ('owner_statement', 'explicit') and retracted_at is null);
end;
create trigger unit_replacement_end before update on unit_replacement begin
  select raise(abort, 'a replacement''s cause belongs to the project of the records it joins')
  where exists (select 1 from extraction_run where id = new.end_run_id
      and project_id is not (select project_id from unit where id = new.to_unit))
    or exists (select 1 from forget_batch where id = new.end_forget_id
      and project_id is not (select project_id from unit where id = new.to_unit));
  select raise(abort, 'a replacement only ever ends, once')
  where old.ended_at is not null or new.ended_at is null or new.id is not old.id or new.from_unit is not old.from_unit
    or new.to_unit is not old.to_unit or new.run_id is not old.run_id or new.forget_id is not old.forget_id
    or new.started_at is not old.started_at;
end;
create trigger unit_replacement_no_delete before delete on unit_replacement
when exists (select 1 from unit where id = old.from_unit) and exists (select 1 from unit where id = old.to_unit) begin
  select raise(abort, 'replacements are history and are never removed');
end;
create trigger unit_rev_replacement_i after insert on unit_replacement begin
  update unit set revision = revision + 1 where id in (new.from_unit, new.to_unit);
end;
create trigger unit_rev_replacement_u after update on unit_replacement begin
  update unit set revision = revision + 1 where id in (new.from_unit, new.to_unit);
end;
create trigger unit_replacement_gap_frozen before update on unit_replacement_gap begin
  select raise(abort, 'a gap in replacement history is never changed');
end;
create trigger unit_state_rules before insert on unit_state begin
  select raise(abort, 'the first state of a unit is candidate, from no state')
  where not exists (select 1 from unit_state where unit_id = new.unit_id)
    and (new.from_state is not null or new.to_state <> 'candidate');
  select raise(abort, 'from_state must be the current lifecycle')
  where new.from_state is not (select lifecycle from unit where id = new.unit_id)
    and exists (select 1 from unit_state where unit_id = new.unit_id);
  select raise(abort, 'not a lifecycle change a unit can make: withdrawn is final, and a superseded unit comes back only once nothing replaces it')
  where exists (select 1 from unit_state where unit_id = new.unit_id) and not (
    (new.from_state = 'candidate' and new.to_state in ('active', 'superseded', 'withdrawn'))
    or (new.from_state = 'active' and new.to_state in ('candidate', 'superseded', 'withdrawn'))
    or (new.from_state = 'superseded' and new.to_state in ('candidate', 'active')
      and not exists (select 1 from unit_replacement where to_unit = new.unit_id and ended_at is null)));
  select raise(abort, 'a quarantined or unsourced unit cannot become active')
  where new.to_state = 'active' and exists (select 1 from unit where id = new.unit_id and (extraction <> 'supported' or unsourced = 1));
  select raise(abort, (select missing from unit_support where unit_id = new.unit_id))
  where new.to_state = 'active' and (select missing from unit_support where unit_id = new.unit_id) is not null;
  -- A reconsider condition is the owner's: each needs a quote of the owner before the unit first becomes active. A quote retracted or
  -- forgotten later leaves the unit as it was (it may come back to active), and readers show the condition as unsupported
  select raise(abort, 'a reconsider condition needs a quote of the owner')
  where new.to_state = 'active' and new.forget_id is null
    and not exists (select 1 from unit_state where unit_id = new.unit_id and to_state = 'active') and exists (select 1 from unit_option o where o.unit_id = new.unit_id
    and o.reconsider_when is not null and not exists (select 1 from unit_evidence e join source s on s.id = e.source_id
      where e.option_id = o.id and e.role = 'reconsiders' and s.author_kind = 'owner'));
  select raise(abort, 'superseded needs a replacement in effect into it')
  where new.to_state = 'superseded' and not exists (select 1 from unit_replacement where to_unit = new.unit_id and ended_at is null);
  select raise(abort, 'a unit something replaces is superseded, not active')
  where new.to_state = 'active' and exists (select 1 from unit_replacement where to_unit = new.unit_id and ended_at is null);
end;
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
create trigger unit_anchor_frozen before update on unit_anchor begin
  select raise(abort, 'anchors are replaced, not edited; retirement happens once')
  where new.unit_id is not old.unit_id or new.path is not old.path or new.symbol is not old.symbol or new.commit_sha is not old.commit_sha
    or new.line_start is not old.line_start or new.line_end is not old.line_end or new.excerpt is not old.excerpt or new.role is not old.role
    or new.edit_observation_id is not old.edit_observation_id or new.run_id is not old.run_id or new.added_at is not old.added_at
    or old.retired_at is not null or new.retired_at is null;
  select raise(abort, 'an anchor is replaced by another anchor of the same record')
  where new.replaced_by is not null and (new.replaced_by = new.id
    or not exists (select 1 from unit_anchor where id = new.replaced_by and unit_id = new.unit_id));
end;
create trigger unit_anchor_no_delete before delete on unit_anchor when exists (select 1 from unit where id = old.unit_id) begin
  select raise(abort, 'anchors are retired, never deleted');
end;
create view agent_ineligible_source as
select s.id as source_id from source s join session se on se.id = s.session_id
where s.kind = 'session_message' and s.author_kind = 'assistant' and (
  -- A reply with no turn cannot be placed apart from a turn that ran a record tool
  s.turn_id is null
  or exists (select 1 from record_call c where c.host = 'codex' and se.host = 'codex' and c.caller_session = se.external_id
    and (c.caller_turn is null or c.caller_turn = s.turn_id))
  -- The hook's row alone counts: the MCP SDK refuses a malformed call before the server can log it
  or exists (select 1 from tool_call_observation o where o.host = 'claude-code' and se.host = 'claude-code'
    and o.session_external = se.external_id and (o.turn_id is null or o.turn_id = s.turn_id))
  or exists (select 1 from record_call c where c.project_id = se.project_id and (c.host is null or c.host = se.host)
    and (c.host is null or (c.host = 'codex' and c.caller_session is null)
      or (c.host = 'claude-code' and not exists (select 1 from tool_call_observation o where o.host = 'claude-code' and o.tool_use_id = c.tool_use_id)))
    and s.created_at >= c.called_at));
create view unit_support as
select u.id as unit_id, case
  when u.kind in ('decision', 'constraint') and (
    not exists (select 1 from unit_evidence e where e.unit_id = u.id and e.option_id is null and e.retracted_at is null)
    or not exists (select 1 from unit_adoption a where a.unit_id = u.id and a.retracted_at is null
      and (a.route <> 'agent' or exists (select 1 from unit_evidence e where e.unit_id = u.id and e.option_id is null and e.role = 'decides'
        and e.source_id = a.source_id and e.span_start = a.span_start and e.span_end = a.span_end and e.retracted_at is null))))
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
create trigger unit_alias_terms before insert on unit_alias begin
  select raise(abort, 'an alias set is bound to the words of its unit as they are')
  where new.content_hash is not (select content_hash from unit where id = new.unit_id);
  select raise(abort, 'each alias is a non-empty string of at most 40 characters')
  where exists (select 1 from json_each(new.terms) where type <> 'text' or length(trim(value)) = 0 or length(value) > 40);
end;
create trigger unit_alias_frozen before update on unit_alias begin
  select raise(abort, 'alias sets are replaced by a newer set, not edited');
end;
create trigger unit_alias_no_delete before delete on unit_alias when exists (select 1 from unit where id = old.unit_id) begin
  select raise(abort, 'alias sets are append-only; write an empty set to clear');
end;
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
  select raise(abort, 'a span starts or ends inside a character')
  where hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_start + 1, 1)) between '80' and 'BF'
     or hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_end + 1, 1)) between '80' and 'BF';
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
  select raise(abort, 'a span starts or ends inside a character')
  where hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_start + 1, 1)) between '80' and 'BF'
     or hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_end + 1, 1)) between '80' and 'BF';
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
create trigger unit_evidence_check before insert on unit_evidence begin
  select raise(abort, 'evidence and unit belong to different projects')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'evidence span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  -- A retraction cites the owner's words, which only the retraction's own update checks: a row is never written already retracted
  select raise(abort, 'evidence is written live, then retracted')
  where new.retracted_at is not null or new.retraction_source_id is not null;
  select raise(abort, 'a span starts or ends inside a character')
  where hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_start + 1, 1)) between '80' and 'BF'
     or hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_end + 1, 1)) between '80' and 'BF';
  select raise(abort, 'a reported speaker is the owner reporting someone else, so it must cite an owner session message')
  where new.reported_speaker is not null and (trim(new.reported_speaker) = '' or not exists (select 1 from source
    where id = new.source_id and kind = 'session_message' and author_kind = 'owner'));
  select raise(abort, 'reconsiders quotes the owner on a rejected option that has a reconsider condition')
  where new.role = 'reconsiders' and (new.option_id is null
    or not exists (select 1 from unit_option where id = new.option_id and reconsider_when is not null)
    or not exists (select 1 from source where id = new.source_id and author_kind = 'owner'));
  -- The AI stating its own choice in a reply: never a question it asked (AskUserQuestion's questions are recorded as its message)
  select raise(abort, 'decides quotes the AI choosing in its own reply, never a question it asked or an option')
  where new.role = 'decides' and (new.option_id is not null or not exists (select 1 from source where id = new.source_id
    and kind = 'session_message' and author_kind = 'assistant' and external_id not glob '*:ask:*:q:*'));
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
  select raise(abort, 'a span starts or ends inside a character')
  where hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_start + 1, 1)) between '80' and 'BF'
     or hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_end + 1, 1)) between '80' and 'BF';
end;
create trigger unit_evidence_no_delete before delete on unit_evidence
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and not (old.retracted_at is not null and not exists (select 1 from source where id = old.retraction_source_id)) begin
  select raise(abort, 'evidence is retracted, never deleted');
end;
create trigger unit_adoption_no_delete before delete on unit_adoption
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and not (old.retracted_at is not null and not exists (select 1 from source where id = old.retraction_source_id)) begin
  select raise(abort, 'adoption is retracted, never deleted');
end;
create trigger unit_adoption_check before insert on unit_adoption begin
  select raise(abort, 'adoption and unit belong to different projects')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'adoption span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  select raise(abort, 'adoption is written live, then retracted')
  where new.retracted_at is not null or new.retraction_source_id is not null;
  select raise(abort, 'a span starts or ends inside a character')
  where hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_start + 1, 1)) between '80' and 'BF'
     or hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_end + 1, 1)) between '80' and 'BF';
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
  select raise(abort, 'a span starts or ends inside a character')
  where hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_start + 1, 1)) between '80' and 'BF'
     or hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_end + 1, 1)) between '80' and 'BF';
end;
create trigger unit_link_check before insert on unit_link begin
  select raise(abort, 'linked units belong to different projects')
  where (select project_id from unit where id = new.from_unit) is not (select project_id from unit where id = new.to_unit)
     or (select project_id from unit where id = new.from_unit) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'a record supersedes one of its own kind; a decision and a constraint can replace each other')
  where new.kind = 'supersedes' and not exists (select 1 from unit a join unit b on b.id = new.to_unit where a.id = new.from_unit
    and (a.kind = b.kind or (a.kind in ('decision', 'constraint') and b.kind in ('decision', 'constraint'))));
end;
create trigger unit_state_project before insert on unit_state begin
  select raise(abort, 'a state comes after its unit was created')
  where new.at < (select created_at from unit where id = new.unit_id);
  select raise(abort, 'state and unit belong to different projects')
  where (new.run_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id))
     or (new.forget_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from forget_batch where id = new.forget_id))
     or (new.source_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id));
end;
create trigger unit_anchor_project before insert on unit_anchor begin
  select raise(abort, 'an anchor is replaced by another anchor of the same record')
  where new.replaced_by is not null and not exists (select 1 from unit_anchor where id = new.replaced_by and unit_id = new.unit_id);
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
create trigger unit_fts_ai after insert on unit begin
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.id;
end;
create trigger unit_fts_ad after delete on unit begin
  delete from unit_fts where rowid = old.id;
end;
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
create trigger delivery_ad after delete on delivery begin
  delete from delivery_unit where delivery_id = old.id;
end;
create view ingest_source as
  select project_id, kind, artifact, external_id, revision, author_kind, author_login, author_external_id, author_association,
    parent_external_id, event_kind, url, created_at, available_at, captured_at, text, truncated, redacted, original_bytes,
    content_hash, path, line_start, line_end, diff_hunk, commit_sha, blob_sha, indexed
  from source where session_id is null;
create trigger ingest_source_insert instead of insert on ingest_source begin
  insert into source (project_id, kind, artifact, external_id, revision, author_kind, author_login, author_external_id, author_association,
    parent_external_id, event_kind, url, created_at, available_at, captured_at, text, truncated, redacted, original_bytes,
    content_hash, path, line_start, line_end, diff_hunk, commit_sha, blob_sha, indexed, session_id, turn_id)
  values (new.project_id, new.kind, new.artifact, new.external_id, new.revision, new.author_kind, new.author_login, new.author_external_id,
    new.author_association, new.parent_external_id, new.event_kind, new.url, new.created_at, new.available_at, new.captured_at,
    new.text, coalesce(new.truncated, 0), coalesce(new.redacted, 0), new.original_bytes, new.content_hash, new.path, new.line_start,
    new.line_end, new.diff_hunk, new.commit_sha, new.blob_sha, new.indexed, null, null);
end;
create view capture_session as select id, project_id, host, external_id, branch, started_at from session;
create trigger capture_session_insert instead of insert on capture_session begin
  select raise(abort, 'the session already exists with different details')
  where exists (select 1 from session where id = new.id and (project_id <> new.project_id or host <> new.host or external_id <> new.external_id));
  insert into session (id, project_id, host, external_id, branch, started_at)
  select new.id, new.project_id, new.host, new.external_id, new.branch, new.started_at
  where not exists (select 1 from session where id = new.id);
end;
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
create view capture_tool_call as
select host, session_external, turn_id, tool_use_id, tool_name, owner_turn, observed_at from tool_call_observation;
create trigger capture_tool_call_insert instead of insert on capture_tool_call begin
  insert into tool_call_observation (host, session_external, turn_id, tool_use_id, tool_name, owner_turn, observed_at)
  values (new.host, new.session_external, new.turn_id, new.tool_use_id, new.tool_name, new.owner_turn, new.observed_at)
  on conflict do nothing;
end;
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
create view capture_delivery_scoped as
  select session_id, agent_id, event, outcome, reason, path, eligible, omitted, chars, at, null as units from delivery;
create trigger capture_delivery_scoped_insert instead of insert on capture_delivery_scoped begin
  select raise(abort, 'the unit and the delivered session belong to different projects')
  where exists (select 1 from json_each(coalesce(new.units, '[]')) j
    where (select project_id from unit where id = j.value) is not (select project_id from session where id = new.session_id));
  insert into delivery (session_id, agent_id, event, outcome, reason, path, eligible, omitted, chars, at)
  values (new.session_id, new.agent_id, new.event, new.outcome, new.reason, new.path, coalesce(new.eligible, 0),
    coalesce(new.omitted, 0), coalesce(new.chars, 0), new.at);
  insert into delivery_unit (delivery_id, unit_id)
  select last_insert_rowid(), j.value from json_each(coalesce(new.units, '[]')) j where true on conflict do nothing;
end;
create view capture_delivery_prune as select null as cutoff, null as session_id;
create trigger capture_delivery_prune_insert instead of insert on capture_delivery_prune begin
  delete from delivery where session_id = new.session_id
    and not exists (select 1 from delivery n where n.session_id = new.session_id and n.at >= new.cutoff);
  delete from delivery where id in (select d.id from delivery d where d.at < new.cutoff
    and (d.session_id is null or not exists (select 1 from delivery n where n.session_id = d.session_id and n.at >= new.cutoff))
    order by d.at, d.id limit 200);
end;

pragma user_version = 10;
