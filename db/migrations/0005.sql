-- Revision 4 → 5 of generation 2: the write boundary, lifecycle transitions, indexes, checks, and unused vocabulary.
-- `sphica init` runs this in one transaction with foreign keys off (set outside the transaction), then checks foreign_key_check before
-- committing. Every statement matches db/schema.sql at revision 5; server/test/migrate.test.ts compares a migrated database with a fresh one.

-- Triggers, views, and indexes are dropped first and all created again at the end: rebuilding a table fails while a trigger names it.
drop trigger source_owner_bound;
drop trigger source_session_project;
drop trigger source_no_update;
drop trigger source_fts_ai;
drop trigger source_fts_ad;
drop trigger unit_insert_candidate;
drop trigger unit_run_project;
drop trigger unit_text_frozen;
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
drop trigger unit_adoption_check;
drop trigger unit_adoption_retract;
drop trigger unit_link_check;
drop trigger unit_state_project;
drop trigger unit_anchor_project;
drop trigger unit_alias_project;
drop trigger source_processing_project;
drop trigger external_reference_check;
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
drop trigger capture_session_insert;
drop trigger capture_message_insert;
drop trigger capture_edit_insert;
drop trigger capture_delivery_insert;
drop view unit_search_text;
drop view capture_session;
drop view capture_message;
drop view capture_edit;
drop view capture_delivery;
drop index source_artifact;
drop index source_session;
drop index source_message_once;
drop index source_item_once;
drop index source_forgotten_item;
drop index edit_observation_path;
drop index unit_live;
drop index unit_evidence_unit_once;
drop index unit_evidence_option_once;
drop index unit_evidence_source;
drop index unit_state_order;
drop index unit_anchor_path;
drop index unit_anchor_unit;
drop index unit_alias_unit;
drop index field_def_source;
drop index unit_field_def;
drop index unit_field_source;
drop index work_open;
drop index delivery_session;

-- Dropping a table forgets its id counter. The counters are put back at the end, so an id once used is never handed out again.
create temp table sphica_sequence as select name, seq from sqlite_sequence;

create table extraction_run_new (
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
insert into extraction_run_new (id, project_id, origin, target, session_id, status, reason, input_bytes, draft_id, started_at, finished_at) select id, project_id, origin, target, session_id, status, reason, input_bytes, draft_id, started_at, finished_at from extraction_run;
drop table extraction_run;
alter table extraction_run_new rename to extraction_run;

-- Repairs. Every row changed or removed is noted, and `sphica init` prints the notes.
create temp table sphica_migration_note (rule text, item text, action text);

-- Units whose lifecycle the new rules cannot have reached go back to candidate. The state history is kept and one state is added,
-- from a run that names this migration, since the triggers that would apply it are dropped here.
create temp table sphica_lifecycle (unit_id integer primary key not null, rule text not null);
insert or ignore into sphica_lifecycle
select u.id, 'a superseded record whose successors are all withdrawn, or that has none'
from unit u where u.lifecycle = 'superseded' and not exists (
  select 1 from unit_link l join unit s on s.id = l.from_unit
  where l.to_unit = u.id and l.kind = 'supersedes' and s.lifecycle <> 'withdrawn');

insert into extraction_run (project_id, origin, target, status, started_at, finished_at)
select distinct u.project_id, 'migration', 'revision:5', 'saved', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
from unit u join sphica_lifecycle f on f.unit_id = u.id;
insert into unit_state (unit_id, from_state, to_state, at, reason, run_id)
select u.id, u.lifecycle, 'candidate', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'schema revision 5: ' || f.rule,
  (select r.id from extraction_run r where r.project_id = u.project_id and r.origin = 'migration' and r.target = 'revision:5')
from unit u join sphica_lifecycle f on f.unit_id = u.id;
insert into sphica_migration_note
select f.rule, 'unit ' || u.id || ' ' || u.key || ' (' || u.lifecycle || ')', 'back to candidate'
from unit u join sphica_lifecycle f on f.unit_id = u.id order by u.id;
update unit set lifecycle = 'candidate', revision = revision + 1 where id in (select unit_id from sphica_lifecycle);
drop table temp.sphica_lifecycle;

-- Rebuild the remaining tables whose definition changed.

update sqlite_sequence set seq = max(seq, (select s.seq from temp.sphica_sequence s where s.name = sqlite_sequence.name))
where name in (select name from temp.sphica_sequence);
insert into sqlite_sequence (name, seq) select s.name, s.seq from temp.sphica_sequence s
where s.name not in (select name from sqlite_sequence) and s.name in (select name from sqlite_schema where type = 'table');
drop table temp.sphica_sequence;

create index source_artifact on source (project_id, artifact, created_at);
create index source_session on source (session_id, created_at) where session_id is not null;
create unique index source_message_once on source (session_id, external_id, revision) where session_id is not null;
create unique index source_item_once on source (project_id, kind, external_id, revision) where session_id is null;
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
create trigger source_fts_ai after insert on source when new.indexed = 1 begin
  insert into source_fts (rowid, lexemes) values (new.id, sphica_terms(new.text));
end;
create trigger source_fts_ad after delete on source when old.indexed = 1 begin
  delete from source_fts where rowid = old.id;
end;
create index source_forgotten_item on source_forgotten (project_id, artifact, kind, external_id, content_hash);
create index edit_observation_path on edit_observation (path);
create index unit_live on unit (project_id, lifecycle, kind);
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
create unique index unit_evidence_unit_once on unit_evidence (unit_id, source_id, span_start, span_end, role) where option_id is null;
create unique index unit_evidence_option_once on unit_evidence (option_id, source_id, span_start, span_end, role) where option_id is not null;
create index unit_evidence_source on unit_evidence (source_id);
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
create index unit_state_order on unit_state (unit_id, id);
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
  select raise(abort, 'an active decision or constraint needs unretracted evidence and adoption')
  where new.to_state = 'active' and exists (select 1 from unit u where u.id = new.unit_id and u.kind in ('decision', 'constraint') and (
    not exists (select 1 from unit_evidence e where e.unit_id = u.id and e.option_id is null and e.retracted_at is null)
    or not exists (select 1 from unit_adoption a where a.unit_id = u.id and a.retracted_at is null)));
  select raise(abort, 'an active implementation needs code or commit evidence')
  where new.to_state = 'active' and exists (select 1 from unit u where u.id = new.unit_id and u.kind = 'implementation' and not (
    exists (select 1 from unit_evidence e join source s on s.id = e.source_id where e.unit_id = u.id and e.option_id is null
      and e.retracted_at is null and e.role = 'implements' and s.kind in ('commit_message', 'file_excerpt'))
    or exists (select 1 from unit_anchor a where a.unit_id = u.id and a.retired_at is null and a.role = 'evidence'
      and (a.commit_sha is not null or (a.edit_observation_id is not null and exists (select 1 from unit_evidence e
        join source s on s.id = e.source_id join edit_observation o on o.id = a.edit_observation_id
        where e.unit_id = u.id and e.option_id is null and e.retracted_at is null and e.role = 'implements'
          and s.session_id = o.session_id))))));
  select raise(abort, 'an active unit needs unretracted evidence')
  where new.to_state = 'active' and exists (select 1 from unit u where u.id = new.unit_id and u.kind in ('finding', 'dead_end', 'question')
    and not exists (select 1 from unit_evidence e where e.unit_id = u.id and e.option_id is null and e.retracted_at is null));
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
create index unit_anchor_path on unit_anchor (path, role) where retired_at is null;
create index unit_anchor_unit on unit_anchor (unit_id, retired_at);
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
create index unit_alias_unit on unit_alias (unit_id, id);
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
create index field_def_source on field_def (source_id);
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
create index unit_field_def on unit_field (field_def_id);
create index unit_field_source on unit_field (source_id);
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
create trigger unit_evidence_retract_support after update of retracted_at on unit_evidence
when exists (select 1 from unit where id = new.unit_id and lifecycle = 'active')
  and not exists (select 1 from unit_evidence where unit_id = new.unit_id and retracted_at is null) begin
  select raise(abort, 'move the unit back to candidate before retracting its last evidence');
end;
create trigger unit_adoption_retract_support after update of retracted_at on unit_adoption
when exists (select 1 from unit where id = new.unit_id and lifecycle = 'active')
  and not exists (select 1 from unit_adoption where unit_id = new.unit_id and retracted_at is null) begin
  select raise(abort, 'move the unit back to candidate before retracting its last adoption');
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
create index work_open on work (project_id, updated_at desc) where status in ('active', 'blocked', 'paused');
create index delivery_session on delivery (session_id, at);
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

-- Rows may have left the indexed text, so both full-text indexes are built again
insert into unit_fts (unit_fts) values ('delete-all');
insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text;
insert into source_fts (source_fts) values ('delete-all');
insert into source_fts (rowid, lexemes) select id, sphica_terms(text) from source where indexed = 1;

pragma user_version = 5;
