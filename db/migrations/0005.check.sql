-- Rows revision 5 cannot take and the migration must not change on its own. `sphica init` runs this first, inside the same transaction,
-- and stops with every row listed when there is any; nothing is changed.

create temp table sphica_migration_stop (rule text, item text);

-- A file excerpt's path is part of its identity, and a source is removed only by the owner's forget
insert into sphica_migration_stop
select 'a file excerpt whose path revision 5 refuses (forget it to go on)', 'source ' || id || ' ' || external_id
from source where kind = 'file_excerpt' and not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*') order by id;

-- Values no release of this generation ever wrote: such a row was written outside Sphica, and revision 5 no longer has the value
insert into sphica_migration_stop
select 'a pull request event other than a merge', 'source ' || id || ' (' || event_kind || ')' from source
where event_kind is not null and event_kind <> 'merged' order by id;
insert into sphica_migration_stop
select 'an extraction run that failed, was capped, or carries a reason', 'run ' || id || ' (' || status || ')' from extraction_run
where status not in ('running', 'saved') or reason is not null order by id;
insert into sphica_migration_stop
select 'a source processing outcome that failed or was capped', 'source ' || source_id || ' in run ' || run_id || ' (' || outcome || ')'
from source_processing where outcome not in ('units', 'no_unit') order by run_id, source_id;
insert into sphica_migration_stop
select 'an implements link between records', 'unit ' || from_unit || ' implements unit ' || to_unit from unit_link
where kind = 'implements' order by from_unit, to_unit;
insert into sphica_migration_stop
select 'an unfetched reference (revision 5 has no table for it)', 'reference ' || id || ' ' || url from external_reference order by id;

-- A retraction's reason cites a span of the owner's words that starts before the text: no release wrote one, and no span can be told
-- from it
insert into sphica_migration_stop
select 'a retraction span starting before its text', 'evidence ' || id || ' of unit ' || unit_id from unit_evidence
where retraction_span_start < 0 order by id;
insert into sphica_migration_stop
select 'a retraction span starting before its text', 'adoption ' || id || ' of unit ' || unit_id from unit_adoption
where retraction_span_start < 0 order by id;
