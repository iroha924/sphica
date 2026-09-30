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

-- Every row the migration changes or removes is noted here, and `sphica init` prints the notes
create temp table sphica_migration_note (rule text, item text, action text);

-- A run that finished before it started takes its start as its finish (the run table is rebuilt next, with that check)
insert into sphica_migration_note
select 'a run that finished before it started', 'run ' || id, 'finished_at set to started_at'
from extraction_run where finished_at < started_at order by id;
update extraction_run set finished_at = started_at where finished_at < started_at;

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
  started_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) is started_at),
  finished_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) is finished_at),
  check (finished_at >= started_at)
) strict;
insert into extraction_run_new (id, project_id, origin, target, session_id, status, input_bytes, draft_id, started_at, finished_at) select id, project_id, origin, target, session_id, status, input_bytes, draft_id, started_at, finished_at from extraction_run;
drop table extraction_run;
alter table extraction_run_new rename to extraction_run;

-- The repairs below add runs: their ids come after every id a run ever had
update sqlite_sequence set seq = max(seq, (select s.seq from temp.sphica_sequence s where s.name = sqlite_sequence.name))
where name in (select name from temp.sphica_sequence);
insert into sqlite_sequence (name, seq) select s.name, s.seq from temp.sphica_sequence s
where s.name not in (select name from sqlite_sequence) and s.name in (select name from sqlite_schema where type = 'table');

-- Repairs. Every row changed or removed is noted, and `sphica init` prints the notes.
-- Small values revision 5 checks: each takes the nearest value it accepts, or the row goes when there is none
insert into sphica_migration_note
select 'an end line without a start line', 'source ' || id, 'line_end cleared' from source where line_end is not null and line_start is null order by id;
update source set line_end = null where line_end is not null and line_start is null;
insert into sphica_migration_note
select 'an end line without a start line', 'anchor ' || id, 'line_end cleared' from unit_anchor where line_end is not null and line_start is null order by id;
update unit_anchor set line_end = null where line_end is not null and line_start is null;
insert into sphica_migration_note
select 'a web address that is not http or https', 'source ' || id, 'url cleared' from source
where url is not null and not (url glob 'https://*' or url glob 'http://*') order by id;
update source set url = null where url is not null and not (url glob 'https://*' or url glob 'http://*');
insert into sphica_migration_note
select 'an assistant reply in the search index', 'source ' || id, 'left out of the index' from source
where author_kind = 'assistant' and indexed = 1 order by id;
update source set indexed = 0 where author_kind = 'assistant' and indexed = 1;
insert into sphica_migration_note
select 'a state dated before its record was made', 'state ' || s.id || ' of unit ' || s.unit_id, 'dated when the record was made'
from unit_state s join unit u on u.id = s.unit_id where s.at < u.created_at order by s.id;
update unit_state set at = (select created_at from unit where id = unit_state.unit_id)
where at < (select created_at from unit where id = unit_state.unit_id);
insert into sphica_migration_note
select 'an anchor replaced by itself or by another record''s anchor', 'anchor ' || a.id, 'replacement cleared'
from unit_anchor a where a.replaced_by is not null and (a.replaced_by = a.id
  or not exists (select 1 from unit_anchor r where r.id = a.replaced_by and r.unit_id = a.unit_id)) order by a.id;
update unit_anchor set replaced_by = null where replaced_by is not null and (replaced_by = id
  or not exists (select 1 from unit_anchor r where r.id = unit_anchor.replaced_by and r.unit_id = unit_anchor.unit_id));
insert into sphica_migration_note
select 'an alias set bound to other words than its record''s', 'alias ' || a.id || ' of unit ' || a.unit_id, 'removed (it was never searched)'
from unit_alias a join unit u on u.id = a.unit_id where a.content_hash <> u.content_hash order by a.id;
delete from unit_alias where content_hash <> (select content_hash from unit where id = unit_alias.unit_id);
insert into sphica_migration_note
select 'a retraction dated before what it retracts', 'evidence ' || id || ' of unit ' || unit_id, 'retracted when it was added'
from unit_evidence where retracted_at < added_at order by id;
update unit_evidence set retracted_at = added_at where retracted_at < added_at;
insert into sphica_migration_note
select 'a retraction dated before what it retracts', 'adoption ' || id || ' of unit ' || unit_id, 'retracted when it was added'
from unit_adoption where retracted_at < added_at order by id;
update unit_adoption set retracted_at = added_at where retracted_at < added_at;
-- A span that cuts a character widens to the whole character (a UTF-8 character has at most three continuation bytes). The widened spans
-- are worked out apart first: adoption keeps its table's unique span through the rebuild, so rows widening onto one span go before any
-- row moves
create temp table sphica_widen (tbl text not null, which text not null, id integer not null, src integer not null, s integer not null,
  e integer not null, what text not null, primary key (tbl, which, id));
insert into sphica_widen select 'unit_evidence', 'span', id, source_id, span_start, span_end, 'evidence' from unit_evidence
where source_id is not null and (hex(substr((select cast(text as blob) from source where id = source_id), span_start + 1, 1)) between '80' and 'BF'
  or hex(substr((select cast(text as blob) from source where id = source_id), span_end + 1, 1)) between '80' and 'BF');
insert into sphica_widen select 'unit_adoption', 'span', id, source_id, span_start, span_end, 'adoption' from unit_adoption
where source_id is not null and (hex(substr((select cast(text as blob) from source where id = source_id), span_start + 1, 1)) between '80' and 'BF'
  or hex(substr((select cast(text as blob) from source where id = source_id), span_end + 1, 1)) between '80' and 'BF');
insert into sphica_widen select 'field_def', 'span', id, source_id, span_start, span_end, 'field definition' from field_def
where source_id is not null and (hex(substr((select cast(text as blob) from source where id = source_id), span_start + 1, 1)) between '80' and 'BF'
  or hex(substr((select cast(text as blob) from source where id = source_id), span_end + 1, 1)) between '80' and 'BF');
insert into sphica_widen select 'unit_field', 'span', id, source_id, span_start, span_end, 'field value' from unit_field
where source_id is not null and (hex(substr((select cast(text as blob) from source where id = source_id), span_start + 1, 1)) between '80' and 'BF'
  or hex(substr((select cast(text as blob) from source where id = source_id), span_end + 1, 1)) between '80' and 'BF');
insert into sphica_widen select 'unit_evidence', 'retraction', id, retraction_source_id, retraction_span_start, retraction_span_end, 'evidence retraction reason' from unit_evidence
where retraction_source_id is not null and (hex(substr((select cast(text as blob) from source where id = retraction_source_id), retraction_span_start + 1, 1)) between '80' and 'BF'
  or hex(substr((select cast(text as blob) from source where id = retraction_source_id), retraction_span_end + 1, 1)) between '80' and 'BF');
insert into sphica_widen select 'unit_adoption', 'retraction', id, retraction_source_id, retraction_span_start, retraction_span_end, 'adoption retraction reason' from unit_adoption
where retraction_source_id is not null and (hex(substr((select cast(text as blob) from source where id = retraction_source_id), retraction_span_start + 1, 1)) between '80' and 'BF'
  or hex(substr((select cast(text as blob) from source where id = retraction_source_id), retraction_span_end + 1, 1)) between '80' and 'BF');
update sphica_widen set s = s - 1 where hex(substr((select cast(text as blob) from source where id = src), s + 1, 1)) between '80' and 'BF';
update sphica_widen set s = s - 1 where hex(substr((select cast(text as blob) from source where id = src), s + 1, 1)) between '80' and 'BF';
update sphica_widen set s = s - 1 where hex(substr((select cast(text as blob) from source where id = src), s + 1, 1)) between '80' and 'BF';
update sphica_widen set e = e + 1 where hex(substr((select cast(text as blob) from source where id = src), e + 1, 1)) between '80' and 'BF';
update sphica_widen set e = e + 1 where hex(substr((select cast(text as blob) from source where id = src), e + 1, 1)) between '80' and 'BF';
update sphica_widen set e = e + 1 where hex(substr((select cast(text as blob) from source where id = src), e + 1, 1)) between '80' and 'BF';
insert into sphica_migration_note
select 'a span that cuts a character (' || what || ')', tbl || ' ' || id, 'widened to whole characters' from sphica_widen order by tbl, which, id;

-- Widening can make two rows cite the same words: a live one stays over a retracted one, then the first
create temp table sphica_twice (tbl text not null, id integer not null, unit_id integer not null);
insert into sphica_twice
select 'unit_evidence', id, unit_id from (
  select e.id, e.unit_id, row_number() over (partition by e.unit_id, e.option_id, e.source_id, coalesce(w.s, e.span_start),
    coalesce(w.e, e.span_end), e.role order by e.retracted_at is null desc, e.id) as n
  from unit_evidence e left join sphica_widen w on w.tbl = 'unit_evidence' and w.which = 'span' and w.id = e.id)
where n > 1;
insert into sphica_twice
select 'unit_adoption', id, unit_id from (
  select a.id, a.unit_id, row_number() over (partition by a.unit_id, a.source_id, coalesce(w.s, a.span_start), coalesce(w.e, a.span_end)
    order by a.retracted_at is null desc, a.id) as n
  from unit_adoption a left join sphica_widen w on w.tbl = 'unit_adoption' and w.which = 'span' and w.id = a.id)
where n > 1;
insert into sphica_migration_note
select case tbl when 'unit_evidence' then 'evidence' else 'adoption' end || ' citing the same words twice after widening',
  case tbl when 'unit_evidence' then 'evidence ' else 'adoption ' end || id || ' of unit ' || unit_id, 'removed'
from sphica_twice order by tbl, id;
delete from unit_evidence where id in (select id from sphica_twice where tbl = 'unit_evidence');
delete from unit_adoption where id in (select id from sphica_twice where tbl = 'unit_adoption');
drop table temp.sphica_twice;
update unit_evidence set span_start = (select s from sphica_widen w where w.tbl = 'unit_evidence' and w.which = 'span' and w.id = unit_evidence.id),
  span_end = (select e from sphica_widen w where w.tbl = 'unit_evidence' and w.which = 'span' and w.id = unit_evidence.id)
where id in (select id from sphica_widen where tbl = 'unit_evidence' and which = 'span');
update unit_adoption set span_start = (select s from sphica_widen w where w.tbl = 'unit_adoption' and w.which = 'span' and w.id = unit_adoption.id),
  span_end = (select e from sphica_widen w where w.tbl = 'unit_adoption' and w.which = 'span' and w.id = unit_adoption.id)
where id in (select id from sphica_widen where tbl = 'unit_adoption' and which = 'span');
update field_def set span_start = (select s from sphica_widen w where w.tbl = 'field_def' and w.which = 'span' and w.id = field_def.id),
  span_end = (select e from sphica_widen w where w.tbl = 'field_def' and w.which = 'span' and w.id = field_def.id)
where id in (select id from sphica_widen where tbl = 'field_def' and which = 'span');
update unit_field set span_start = (select s from sphica_widen w where w.tbl = 'unit_field' and w.which = 'span' and w.id = unit_field.id),
  span_end = (select e from sphica_widen w where w.tbl = 'unit_field' and w.which = 'span' and w.id = unit_field.id)
where id in (select id from sphica_widen where tbl = 'unit_field' and which = 'span');
update unit_evidence set retraction_span_start = (select s from sphica_widen w where w.tbl = 'unit_evidence' and w.which = 'retraction' and w.id = unit_evidence.id),
  retraction_span_end = (select e from sphica_widen w where w.tbl = 'unit_evidence' and w.which = 'retraction' and w.id = unit_evidence.id)
where id in (select id from sphica_widen where tbl = 'unit_evidence' and which = 'retraction');
update unit_adoption set retraction_span_start = (select s from sphica_widen w where w.tbl = 'unit_adoption' and w.which = 'retraction' and w.id = unit_adoption.id),
  retraction_span_end = (select e from sphica_widen w where w.tbl = 'unit_adoption' and w.which = 'retraction' and w.id = unit_adoption.id)
where id in (select id from sphica_widen where tbl = 'unit_adoption' and which = 'retraction');
drop table temp.sphica_widen;


-- Paths revision 5 refuses (a control character, or a spelling like `a//b` or `./a` that names a place two ways): an edit observation
-- or an anchor with one is removed, and a review comment keeps its text without the path. A file excerpt with one stops the migration
-- before this (0005.check.sql): its path is its identity.
insert into sphica_migration_note
select 'an anchor whose path revision 5 refuses', 'anchor ' || id || ' of unit ' || unit_id, 'removed'
from unit_anchor where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*') order by id;
update unit set revision = revision + 1 where id in (select unit_id from unit_anchor where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*'));
insert into sphica_migration_note
select 'an anchor replaced by one whose path revision 5 refuses', 'anchor ' || id || ' of unit ' || unit_id, 'no longer points at what replaced it'
from unit_anchor where replaced_by in (select id from unit_anchor where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*')) order by id;
update unit_anchor set replaced_by = null where replaced_by in (select id from unit_anchor where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*'));
delete from unit_anchor where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*');
insert into sphica_migration_note
select 'an edit observation whose path revision 5 refuses', 'observation ' || id || ' in session ' || session_id, 'removed'
from edit_observation where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*') order by id;
update unit_anchor set edit_observation_id = null
where edit_observation_id in (select id from edit_observation where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*'));
delete from edit_observation where not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*');
insert into sphica_migration_note
select 'a source whose path revision 5 refuses', 'source ' || id || ' (' || kind || ')', 'path and lines removed; the text stays'
from source where path is not null and kind <> 'file_excerpt' and not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*') order by id;
update source set path = null, line_start = null, line_end = null
where path is not null and kind <> 'file_excerpt' and not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*');

-- Edit observations repeated for a session, turn (none counting as one), path, and way: the first stays, and anchors citing a later one
-- cite the first instead
create temp table sphica_observation (id integer primary key not null, keep integer not null);
insert into sphica_observation
select o.id, k.keep from edit_observation o join (
  select session_id, coalesce(turn_id, '') as turn, path, via, min(id) as keep from edit_observation
  group by session_id, coalesce(turn_id, ''), path, via having count(*) > 1) k
on k.session_id = o.session_id and k.turn = coalesce(o.turn_id, '') and k.path = o.path and k.via = o.via;
delete from sphica_observation where id = keep;
insert into sphica_migration_note
select 'an edit observation recorded twice', 'observation ' || o.id || ' of ' || e.path || ' in session ' || e.session_id,
  'removed; observation ' || o.keep || ' stays'
from sphica_observation o join edit_observation e on e.id = o.id order by o.id;
update unit_anchor set edit_observation_id = (select keep from sphica_observation where id = unit_anchor.edit_observation_id)
where edit_observation_id in (select id from sphica_observation);
delete from edit_observation where id in (select id from sphica_observation);
drop table temp.sphica_observation;

-- Live anchors of one unit on the same place: the newest stays live, and each older one is retired and points at it
create temp table sphica_anchor (id integer primary key not null, keep integer not null);
insert into sphica_anchor
select a.id, k.keep from unit_anchor a join (
  select unit_id, path, role, coalesce(commit_sha, '') as c, coalesce(symbol, '') as s,
    coalesce(case when symbol is null then line_start end, 0) as l1, coalesce(case when symbol is null then line_end end, 0) as l2,
    max(id) as keep
  from unit_anchor where retired_at is null
  group by unit_id, path, role, coalesce(commit_sha, ''), coalesce(symbol, ''),
    coalesce(case when symbol is null then line_start end, 0), coalesce(case when symbol is null then line_end end, 0)
  having count(*) > 1) k
on k.unit_id = a.unit_id and k.path = a.path and k.role = a.role and k.c = coalesce(a.commit_sha, '') and k.s = coalesce(a.symbol, '')
  and k.l1 = coalesce(case when a.symbol is null then a.line_start end, 0)
  and k.l2 = coalesce(case when a.symbol is null then a.line_end end, 0)
where a.retired_at is null;
delete from sphica_anchor where id = keep;
insert into sphica_migration_note
select 'two live anchors of a record on one place', 'anchor ' || x.id || ' of unit ' || a.unit_id || ' on ' || a.path,
  'retired; anchor ' || x.keep || ' stays'
from sphica_anchor x join unit_anchor a on a.id = x.id order by x.id;
update unit_anchor set retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), replaced_by = (select keep from sphica_anchor where id = unit_anchor.id)
where id in (select id from sphica_anchor);
update unit set revision = revision + 1 where id in (select a.unit_id from sphica_anchor x join unit_anchor a on a.id = x.id);
drop table temp.sphica_anchor;

-- Supersedes links revision 5 refuses are removed first, so the lifecycle repairs below see what is left: a record replacing one of
-- another kind (a decision and a constraint may replace each other), and every live successor of a record but one (an active one first,
-- then the newest). Withdrawn, quarantined, and unsourced successors keep their links: they hold no place.
create temp table sphica_link (from_unit integer not null, to_unit integer not null, rule text not null, primary key (from_unit, to_unit));
insert or ignore into sphica_link
select l.from_unit, l.to_unit, 'a supersedes link between records of kinds that cannot replace each other'
from unit_link l join unit a on a.id = l.from_unit join unit b on b.id = l.to_unit
where l.kind = 'supersedes' and a.kind <> b.kind
  and not (a.kind in ('decision', 'constraint') and b.kind in ('decision', 'constraint'));
insert or ignore into sphica_link
select l.from_unit, l.to_unit, 'a second successor of a record whose first successor is not withdrawn'
from unit_link l join unit s on s.id = l.from_unit
where l.kind = 'supersedes' and s.lifecycle <> 'withdrawn' and s.extraction = 'supported' and s.unsourced = 0
  and not exists (select 1 from sphica_link x where x.from_unit = l.from_unit and x.to_unit = l.to_unit)
  and l.from_unit <> (select k.from_unit from unit_link k join unit n on n.id = k.from_unit
    where k.to_unit = l.to_unit and k.kind = 'supersedes' and n.lifecycle <> 'withdrawn' and n.extraction = 'supported' and n.unsourced = 0
      and not exists (select 1 from sphica_link x where x.from_unit = k.from_unit and x.to_unit = k.to_unit)
    order by n.lifecycle = 'active' desc, n.id desc limit 1);
insert into sphica_migration_note
select x.rule, 'unit ' || a.id || ' ' || a.key || ' supersedes unit ' || b.id || ' ' || b.key, 'link removed'
from sphica_link x join unit a on a.id = x.from_unit join unit b on b.id = x.to_unit order by x.from_unit, x.to_unit;
delete from unit_link where kind = 'supersedes' and exists (select 1 from sphica_link x
  where x.from_unit = unit_link.from_unit and x.to_unit = unit_link.to_unit);
update unit set revision = revision + 1 where id in (select from_unit from sphica_link union select to_unit from sphica_link);
drop table temp.sphica_link;

-- Units whose lifecycle the new rules cannot have reached go back to candidate. The state history is kept and one state is added,
-- from a run that names this migration, since the triggers that would apply it are dropped here.
create temp table sphica_lifecycle (unit_id integer primary key not null, rule text not null);
insert or ignore into sphica_lifecycle
select u.id, 'a superseded record whose successors are all withdrawn, or that has none'
from unit u where u.lifecycle = 'superseded' and not exists (
  select 1 from unit_link l join unit s on s.id = l.from_unit
  where l.to_unit = u.id and l.kind = 'supersedes' and s.lifecycle <> 'withdrawn' and s.extraction = 'supported' and s.unsourced = 0);
-- The support rule of revision 5, only while this asks it (the view is created for good with the others at the end)
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
insert or ignore into sphica_lifecycle
select u.id, 'an active record without the support an active record needs'
from unit u join unit_support s on s.unit_id = u.id where u.lifecycle = 'active' and s.missing is not null;
drop view unit_support;

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
create table source_new (
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
  -- The comment or thread this replies to
  parent_external_id text,
  -- For pr_event: merged (the one event harvest records)
  event_kind text check (event_kind in ('merged')),
  -- Where it lives on the web; any other scheme (javascript:, file:) is never kept, since readers may show it as a link
  url text check (url glob 'https://*' or url glob 'http://*'),
  created_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) is created_at),
  available_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', available_at) is available_at),
  captured_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', captured_at) is captured_at),
  text text not null,
  truncated integer not null default 0 check (truncated in (0, 1)),
  redacted integer not null default 0 check (redacted in (0, 1)),
  original_bytes integer not null check (original_bytes >= 0),
  content_hash blob not null check (length(content_hash) = 32),
  -- Code position of a review comment or a file excerpt: a normalized repository-relative path with forward slashes
  path text check (path is null or (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end is null or (line_start is not null and line_end >= line_start)),
  diff_hunk text,
  commit_sha text check (commit_sha is null or (length(commit_sha) = 40 and commit_sha not glob '*[^0-9a-f]*')),
  blob_sha text check (blob_sha is null or (length(blob_sha) = 40 and blob_sha not glob '*[^0-9a-f]*')),
  -- 1 when searched in the source index (owner words and third-party text; assistant replies are not)
  indexed integer not null check (indexed in (0, 1)),
  check ((kind = 'session_message') = (session_id is not null)),
  check ((kind = 'pr_event') = (event_kind is not null)),
  check (kind <> 'session_message' or author_kind in ('owner', 'assistant')),
  check (kind = 'session_message' or author_kind <> 'assistant'),
  check (author_kind <> 'assistant' or indexed = 0),
  check (kind <> 'file_excerpt' or (path is not null and commit_sha is not null and blob_sha is not null
    and line_start is not null and line_end is not null)),
  check (truncated = 1 or redacted = 1 or original_bytes = length(cast(text as blob)))
) strict;
insert into source_new (id, project_id, kind, artifact, external_id, revision, session_id, turn_id, author_kind, author_login, author_external_id, author_association, parent_external_id, event_kind, url, created_at, available_at, captured_at, text, truncated, redacted, original_bytes, content_hash, path, line_start, line_end, diff_hunk, commit_sha, blob_sha, indexed) select id, project_id, kind, artifact, external_id, revision, session_id, turn_id, author_kind, author_login, author_external_id, author_association, parent_external_id, event_kind, url, created_at, available_at, captured_at, text, truncated, redacted, original_bytes, content_hash, path, line_start, line_end, diff_hunk, commit_sha, blob_sha, indexed from source;
drop table source;
alter table source_new rename to source;

create table edit_observation_new (
  id integer primary key autoincrement not null,
  session_id text not null references session (id) on delete cascade,
  turn_id text,
  tool_event_id text,
  path text not null check (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*'),
  via text not null check (via in ('tool', 'status')),
  observed_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) is observed_at)
) strict;
insert into edit_observation_new (id, session_id, turn_id, tool_event_id, path, via, observed_at) select id, session_id, turn_id, tool_event_id, path, via, observed_at from edit_observation;
drop table edit_observation;
alter table edit_observation_new rename to edit_observation;

create table source_processing_new (
  source_id integer not null references source (id) on delete cascade,
  run_id integer not null references extraction_run (id) on delete cascade,
  outcome text not null check (outcome in ('units', 'no_unit')),
  primary key (source_id, run_id)
) strict;
insert into source_processing_new (source_id, run_id, outcome) select source_id, run_id, outcome from source_processing;
drop table source_processing;
alter table source_processing_new rename to source_processing;

create table unit_evidence_new (
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
  route text not null check (route in ('owner_statement', 'explicit')),
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

create table unit_link_new (
  from_unit integer not null references unit (id) on delete cascade,
  to_unit integer not null references unit (id) on delete cascade,
  kind text not null check (kind in ('supersedes', 'conflicts')),
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
insert into unit_link_new (from_unit, to_unit, kind, run_id, added_at, resolved_at, resolution) select from_unit, to_unit, kind, run_id, added_at, resolved_at, resolution from unit_link;
drop table unit_link;
alter table unit_link_new rename to unit_link;

create table unit_anchor_new (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  path text not null check (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*'),
  symbol text,
  commit_sha text check (commit_sha is null or (length(commit_sha) = 40 and commit_sha not glob '*[^0-9a-f]*')),
  line_start integer check (line_start > 0),
  line_end integer check (line_end is null or (line_start is not null and line_end >= line_start)),
  excerpt text,
  role text not null check (role in ('applies_to', 'evidence')),
  -- For work recorded before a commit: the edit observation of this path in the session, checked against the working tree when saved
  edit_observation_id integer references edit_observation (id),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  retired_at text check (strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) is retired_at),
  replaced_by integer references unit_anchor (id)
) strict;
insert into unit_anchor_new (id, unit_id, path, symbol, commit_sha, line_start, line_end, excerpt, role, edit_observation_id, run_id, added_at, retired_at, replaced_by) select id, unit_id, path, symbol, commit_sha, line_start, line_end, excerpt, role, edit_observation_id, run_id, added_at, retired_at, replaced_by from unit_anchor;
drop table unit_anchor;
alter table unit_anchor_new rename to unit_anchor;

drop table external_reference;

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
create index forget_batch_project on forget_batch (project_id);
create index source_forgotten_batch on source_forgotten (batch_id);
create index source_forgotten_item on source_forgotten (project_id, artifact, kind, external_id, content_hash);
create unique index edit_observation_once on edit_observation (session_id, coalesce(turn_id, ''), path, via);
create index edit_observation_path on edit_observation (path);
create index extraction_run_project on extraction_run (project_id);
create index extraction_run_session on extraction_run (session_id) where session_id is not null;
create trigger extraction_run_frozen before update on extraction_run
when new.id is not old.id or new.project_id is not old.project_id or new.origin is not old.origin or new.target is not old.target
  or new.input_bytes is not old.input_bytes or new.draft_id is not old.draft_id
  or new.started_at is not old.started_at
  or (new.session_id is not old.session_id and (new.session_id is not null or exists (select 1 from session where id = old.session_id)))
  or ((new.status is not old.status or new.finished_at is not old.finished_at) and old.status <> 'running') begin
  select raise(abort, 'a run changes once, when it finishes');
end;
create index source_processing_run on source_processing (run_id);
create index unit_live on unit (project_id, lifecycle, kind);
create index unit_content on unit (project_id, content_hash);
create index unit_run on unit (run_id);
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
create index unit_evidence_option on unit_evidence (unit_id, option_id);
create index unit_evidence_retraction on unit_evidence (retraction_source_id) where retraction_source_id is not null;
create index unit_evidence_run on unit_evidence (run_id);
create index unit_adoption_source on unit_adoption (source_id);
create index unit_adoption_retraction on unit_adoption (retraction_source_id) where retraction_source_id is not null;
create index unit_adoption_run on unit_adoption (run_id);
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
end;
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
      select 1 from unit_link l join unit s on s.id = l.from_unit where l.to_unit = new.unit_id and l.kind = 'supersedes'
        and s.extraction = 'supported' and s.unsourced = 0
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
create trigger unit_state_restore after insert on unit_state when new.to_state = 'withdrawn' begin
  insert into unit_state (unit_id, from_state, to_state, at, reason, source_id, run_id, forget_id)
  select o.id, 'superseded', 'candidate', new.at, 'its successor was withdrawn', new.source_id, new.run_id, new.forget_id
  from unit_link l join unit o on o.id = l.to_unit
  where l.from_unit = new.unit_id and l.kind = 'supersedes' and o.lifecycle = 'superseded'
    and not exists (select 1 from unit_link k join unit s on s.id = k.from_unit where k.to_unit = o.id and k.kind = 'supersedes'
      and k.from_unit <> new.unit_id and s.extraction = 'supported' and s.unsourced = 0
      and (select to_state from unit_state where unit_id = k.from_unit order by id desc limit 1) is not 'withdrawn');
end;
create index unit_anchor_path on unit_anchor (path, role) where retired_at is null;
create index unit_anchor_unit on unit_anchor (unit_id, retired_at);
create unique index unit_anchor_live_once on unit_anchor (unit_id, path, role, coalesce(commit_sha, ''), coalesce(symbol, ''),
  coalesce(case when symbol is null then line_start end, 0), coalesce(case when symbol is null then line_end end, 0))
  where retired_at is null;
create index unit_anchor_observation on unit_anchor (edit_observation_id) where edit_observation_id is not null;
create index unit_anchor_replaced on unit_anchor (replaced_by) where replaced_by is not null;
create index unit_anchor_run on unit_anchor (run_id);
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
create index unit_alias_unit on unit_alias (unit_id, id);
create index unit_alias_run on unit_alias (run_id);
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
  select raise(abort, 'a span starts or ends inside a character')
  where new.retraction_source_id is not null and (
    hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_start + 1, 1)) between '80' and 'BF'
    or hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_end + 1, 1)) between '80' and 'BF');
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
  select raise(abort, 'a span starts or ends inside a character')
  where new.retraction_source_id is not null and (
    hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_start + 1, 1)) between '80' and 'BF'
    or hex(substr((select cast(text as blob) from source where id = new.retraction_source_id), new.retraction_span_end + 1, 1)) between '80' and 'BF');
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
  -- One live successor at a time. A withdrawn one gives its place up, and a quarantined or unsourced one never takes it: it can never
  -- become active, nor be withdrawn. States are read from history, as in unit_state_rules
  select raise(abort, 'the record already has a successor that is not withdrawn')
  where new.kind = 'supersedes'
    and exists (select 1 from unit n where n.id = new.from_unit and n.extraction = 'supported' and n.unsourced = 0)
    and exists (select 1 from unit_link l join unit s on s.id = l.from_unit
    where l.to_unit = new.to_unit and l.kind = 'supersedes' and s.extraction = 'supported' and s.unsourced = 0
      and (select to_state from unit_state where unit_id = l.from_unit order by id desc limit 1) is not 'withdrawn');
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
create index work_open on work (project_id, updated_at desc) where status in ('active', 'blocked', 'paused');
create index work_run on work (run_id) where run_id is not null;
create index delivery_session on delivery (session_id, at);
create index delivery_unit_unit on delivery_unit (unit_id);
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
