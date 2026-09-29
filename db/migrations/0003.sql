-- Revision 2 → 3 of generation 2: a rejected option can carry a reconsider condition the owner stated, quoted as `reconsiders` evidence (issue #193).
-- `sphica init` runs this in one transaction with foreign keys off (set outside the transaction), then checks foreign_key_check before
-- committing. Every statement matches db/schema.sql at revision 3; server/test/migrate.test.ts compares a migrated database with a fresh one.

-- Rebuild unit_option and unit_evidence (https://www.sqlite.org/lang_altertable.html#otheralter). What names them from elsewhere is dropped
-- first, or the renames fail on it: the state rules, the search view, and the triggers that read the view. All are created again after.
drop trigger unit_state_rules;
drop trigger unit_fts_ai;
drop trigger unit_fts_anchor_i;
drop trigger unit_fts_anchor_u;
drop trigger unit_fts_anchor_d;
drop trigger unit_fts_alias_i;
drop trigger unit_fts_alias_d;
drop view unit_search_text;

create table unit_option_new (
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
insert into unit_option_new (id, unit_id, position, text, outcome, why)
  select id, unit_id, position, text, outcome, why from unit_option;
-- AUTOINCREMENT never reuses an id: carry the counter over
delete from sqlite_sequence where name = 'unit_option_new';
insert into sqlite_sequence (name, seq) select 'unit_option_new', seq from sqlite_sequence where name = 'unit_option';
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
insert into unit_evidence_new (id, unit_id, option_id, source_id, span_start, span_end, role, reported_speaker, run_id, added_at, retracted_at, retraction_reason, retraction_source_id, retraction_span_start, retraction_span_end)
  select id, unit_id, option_id, source_id, span_start, span_end, role, reported_speaker, run_id, added_at, retracted_at, retraction_reason, retraction_source_id, retraction_span_start, retraction_span_end from unit_evidence;
-- AUTOINCREMENT never reuses an id: carry the counter over
delete from sqlite_sequence where name = 'unit_evidence_new';
insert into sqlite_sequence (name, seq) select 'unit_evidence_new', seq from sqlite_sequence where name = 'unit_evidence';
drop table unit_evidence;
drop table unit_option;
alter table unit_option_new rename to unit_option;
alter table unit_evidence_new rename to unit_evidence;

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
create trigger unit_evidence_retract_support after update of retracted_at on unit_evidence
when exists (select 1 from unit where id = new.unit_id and lifecycle = 'active')
  and not exists (select 1 from unit_evidence where unit_id = new.unit_id and retracted_at is null) begin
  select raise(abort, 'move the unit back to candidate before retracting its last evidence');
end;
create trigger unit_rev_evidence_i after insert on unit_evidence begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_evidence_u after update on unit_evidence begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_evidence_d after delete on unit_evidence when exists (select 1 from unit where id = old.unit_id) begin
  update unit set revision = revision + 1 where id = old.unit_id;
end;
create trigger unit_state_rules before insert on unit_state begin
  select raise(abort, 'from_state must be the current lifecycle')
  where new.from_state is not (select lifecycle from unit where id = new.unit_id)
    and exists (select 1 from unit_state where unit_id = new.unit_id);
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
  select raise(abort, 'superseded needs a supersedes link from its successor')
  where new.to_state = 'superseded' and not exists (select 1 from unit_link where to_unit = new.unit_id and kind = 'supersedes');
end;
create view unit_search_text as
select u.id,
  sphica_terms(u.text || char(10) || coalesce(u.why, '') || char(10) || coalesce(u.scope_note, '') || char(10)
    || coalesce(u.revisit_when, '') || char(10)
    || coalesce((select group_concat(o.text || ' ' || coalesce(o.why, '') || ' ' || coalesce(o.reconsider_when, ''), char(10))
      from (select text, why, reconsider_when from unit_option where unit_id = u.id order by position) o), '')) as body,
  sphica_terms(coalesce((select group_concat(a.path || ' ' || coalesce(a.symbol, ''), char(10))
    from (select path, symbol from unit_anchor where unit_id = u.id and retired_at is null order by id) a), '')) as ident,
  sphica_terms(coalesce((select group_concat(j.value, ' ')
    from json_each((select terms from unit_alias where unit_id = u.id and content_hash = u.content_hash order by id desc limit 1)) j), ''))
    as alias
from unit u;
create trigger unit_fts_ai after insert on unit begin
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.id;
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

pragma user_version = 3;
