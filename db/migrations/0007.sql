-- Revision 6 → 7 of generation 2: capture prunes the deliveries of sessions idle past a cutoff, so delivery_unit loses its cascade from
-- delivery (capture may not delete through one) and delivery_ad removes the units. Runs in one transaction with foreign keys off; every
-- statement matches db/schema.sql at revision 7, and server/test/migrate.test.ts compares the two.

drop trigger capture_delivery_insert;
drop trigger capture_delivery_scoped_insert;
create table delivery_unit_new (
  delivery_id integer not null references delivery (id),
  unit_id integer not null references unit (id) on delete cascade,
  primary key (delivery_id, unit_id)
) strict;
insert into delivery_unit_new (delivery_id, unit_id) select delivery_id, unit_id from delivery_unit;
drop table delivery_unit;
alter table delivery_unit_new rename to delivery_unit;
create index delivery_unit_unit on delivery_unit (unit_id);
create trigger delivery_ad after delete on delivery begin
  delete from delivery_unit where delivery_id = old.id;
end;
create index delivery_at on delivery (at);
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
create view capture_delivery_prune as select null as cutoff;
create trigger capture_delivery_prune_insert instead of insert on capture_delivery_prune begin
  delete from delivery where id in (select d.id from delivery d where d.at < new.cutoff
    and (d.session_id is null or not exists (select 1 from delivery n where n.session_id = d.session_id and n.at >= new.cutoff))
    order by d.at, d.id limit 200);
end;

pragma user_version = 7;
