-- Revision 5 → 6 of generation 2: the subagent a delivery ran in (existing rows keep null, the main conversation), and a capture view
-- that writes it while capture_delivery keeps its columns. `sphica init` runs this in one transaction with foreign keys off, then checks
-- foreign_key_check. Every statement matches db/schema.sql at revision 6; server/test/migrate.test.ts compares the two.

alter table delivery add column agent_id text check (length(agent_id) between 1 and 200);

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

pragma user_version = 6;
