-- Revision 1 → 2 of generation 2: the owner can forget chosen sources.
-- `sphica init` runs this in one transaction with foreign keys off (set outside the transaction), then checks foreign_key_check before
-- committing. Every statement matches db/schema.sql at revision 2; server/test/migrate.test.ts compares a migrated database with a fresh one.

-- One owner-confirmed deletion of chosen sources. It stands in for an extraction run on the state changes the deletion causes.
create table forget_batch (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', at) is at)
) strict;

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
-- Not unique: an edited item that returns to earlier text has two revisions with the same hash, and both can be forgotten
create index source_forgotten_item on source_forgotten (project_id, artifact, kind, external_id, content_hash);

-- Rebuild unit_state (https://www.sqlite.org/lang_altertable.html#otheralter). The triggers on other tables that name it are dropped
-- first, or the rename fails on them, and are created again after it.
drop trigger unit_lifecycle_via_state;
drop trigger unit_option_sealed;
create table unit_state_new (
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
insert into unit_state_new (id, unit_id, from_state, to_state, at, reason, source_id, run_id)
  select id, unit_id, from_state, to_state, at, reason, source_id, run_id from unit_state;
-- AUTOINCREMENT never reuses an id: carry the counter over (dropping unit_state drops its row, and the rename moves this one)
delete from sqlite_sequence where name = 'unit_state_new';
insert into sqlite_sequence (name, seq) select 'unit_state_new', seq from sqlite_sequence where name = 'unit_state';
drop table unit_state;
alter table unit_state_new rename to unit_state;
create index unit_state_order on unit_state (unit_id, id);
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
  select raise(abort, 'superseded needs a supersedes link from its successor')
  where new.to_state = 'superseded' and not exists (select 1 from unit_link where to_unit = new.unit_id and kind = 'supersedes');
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
create trigger unit_state_project before insert on unit_state begin
  select raise(abort, 'state and unit belong to different projects')
  where (new.run_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id))
     or (new.forget_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from forget_batch where id = new.forget_id))
     or (new.source_id is not null
       and (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id));
end;
create trigger unit_lifecycle_via_state before update of lifecycle on unit
when new.lifecycle is not (select to_state from unit_state where unit_id = new.id order by id desc limit 1) begin
  select raise(abort, 'lifecycle changes only through unit_state');
end;
create trigger unit_option_sealed before insert on unit_option
when exists (select 1 from unit_state where unit_id = new.unit_id) or exists (select 1 from unit_alias where unit_id = new.unit_id) begin
  select raise(abort, 'options are written with the unit, before its first state; record a successor instead');
end;

drop trigger unit_evidence_no_delete;
create trigger unit_evidence_no_delete before delete on unit_evidence
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and not (old.retracted_at is not null and exists (select 1 from source_forgotten where source_id = old.retraction_source_id)) begin
  select raise(abort, 'evidence is retracted, never deleted');
end;
drop trigger unit_adoption_no_delete;
create trigger unit_adoption_no_delete before delete on unit_adoption
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and not (old.retracted_at is not null and exists (select 1 from source_forgotten where source_id = old.retraction_source_id)) begin
  select raise(abort, 'adoption is retracted, never deleted');
end;
drop trigger capture_message_insert;
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
create trigger unit_rev_evidence_d after delete on unit_evidence when exists (select 1 from unit where id = old.unit_id) begin
  update unit set revision = revision + 1 where id = old.unit_id;
end;
create trigger unit_rev_adoption_d after delete on unit_adoption when exists (select 1 from unit where id = old.unit_id) begin
  update unit set revision = revision + 1 where id = old.unit_id;
end;

pragma user_version = 2;
