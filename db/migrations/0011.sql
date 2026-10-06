-- Revision 10 → 11 of generation 2: a harvest run keeps the sources it may cite, chosen when it begins (harvest_run_source). A running
-- harvest has none, so it is removed and its session gets "Begin again"; nothing cites a running run (a save also finishes it).
-- Every statement that stays is the same as in the schema at revision 11.

create temp table sphica_migration_note (rule text, item text, action text);

create table harvest_run_source (
  run_id integer not null references extraction_run (id) on delete cascade,
  source_id integer not null references source (id) on delete cascade,
  primary key (run_id, source_id)
) strict;
create index harvest_run_source_source on harvest_run_source (source_id);

create trigger harvest_run_source_run before insert on harvest_run_source begin
  select raise(abort, 'only a harvest run keeps sources, from its own project')
  where (select origin from extraction_run where id = new.run_id) is not 'harvest'
    or (select project_id from source where id = new.source_id) is not (select project_id from extraction_run where id = new.run_id);
end;

insert into sphica_migration_note
select 'a harvest run still running, begun before its sources were kept', 'run ' || id || ' ' || target || ' begun ' || started_at,
  'removed; begin the harvest again'
from extraction_run where origin = 'harvest' and status = 'running' order by id;
delete from extraction_run where origin = 'harvest' and status = 'running';

pragma user_version = 11;
