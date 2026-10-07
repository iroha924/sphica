-- Revision 11 → 12 of generation 2: glean keeps the owner's words that retired or moved an anchor (unit_anchor_retirement). Anchors
-- retired before it have no reason row; nothing is inferred for them. Every statement is the same as in the schema at revision 12.

create table unit_anchor_retirement (
  anchor_id integer primary key not null references unit_anchor (id) on delete cascade,
  run_id integer not null references extraction_run (id),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at)
) strict;
create index unit_anchor_retirement_run on unit_anchor_retirement (run_id);
create index unit_anchor_retirement_source on unit_anchor_retirement (source_id);
create trigger unit_anchor_retirement_check before insert on unit_anchor_retirement begin
  select raise(abort, 'a retirement reason is written for a retired anchor')
  where not exists (select 1 from unit_anchor where id = new.anchor_id and retired_at is not null);
  select raise(abort, 'retirement reason and anchor belong to different projects')
  where (select u.project_id from unit_anchor a join unit u on u.id = a.unit_id where a.id = new.anchor_id)
      is not (select project_id from source where id = new.source_id)
     or (select u.project_id from unit_anchor a join unit u on u.id = a.unit_id where a.id = new.anchor_id)
      is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'only the owner''s words retire an anchor')
  where not exists (select 1 from source where id = new.source_id and author_kind = 'owner');
  select raise(abort, 'retirement span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  select raise(abort, 'a span starts or ends inside a character')
  where hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_start + 1, 1)) between '80' and 'BF'
     or hex(substr((select cast(text as blob) from source where id = new.source_id), new.span_end + 1, 1)) between '80' and 'BF';
end;
create trigger unit_anchor_retirement_frozen before update on unit_anchor_retirement begin
  select raise(abort, 'a retirement reason is never changed');
end;
create trigger unit_anchor_retirement_no_delete before delete on unit_anchor_retirement
when exists (select 1 from unit_anchor where id = old.anchor_id) and exists (select 1 from source where id = old.source_id) begin
  select raise(abort, 'a retirement reason goes only with its anchor or its source');
end;

drop trigger session_cited;
create trigger session_cited before delete on session
when exists (select 1 from project where id = old.project_id) and (
  exists (select 1 from source s where s.session_id = old.id and (
    exists (select 1 from unit_evidence e where e.source_id = s.id or e.retraction_source_id = s.id)
    or exists (select 1 from unit_adoption a where a.source_id = s.id or a.retraction_source_id = s.id)
    or exists (select 1 from field_def d where d.source_id = s.id)
    or exists (select 1 from unit_field f where f.source_id = s.id)
    or exists (select 1 from unit_state t where t.source_id = s.id)
    or exists (select 1 from unit_anchor_retirement r where r.source_id = s.id)))
  or exists (select 1 from edit_observation o join unit_anchor a on a.edit_observation_id = o.id where o.session_id = old.id)) begin
  select raise(abort, 'records cite this session; forget its messages with /sphica:forget rather than deleting it');
end;

create trigger unit_rev_retirement_i after insert on unit_anchor_retirement begin
  update unit set revision = revision + 1 where id = (select unit_id from unit_anchor where id = new.anchor_id);
end;
create trigger unit_rev_retirement_d after delete on unit_anchor_retirement begin
  update unit set revision = revision + 1 where id = (select unit_id from unit_anchor where id = old.anchor_id);
end;

pragma user_version = 12;
