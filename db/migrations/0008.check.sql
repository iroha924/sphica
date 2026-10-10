-- Copyright (c) 2026 iroha924 and contributors
-- SPDX-License-Identifier: MIT

-- Rows revision 8 cannot take and the migration must not change on its own. `sphica init` runs this first, inside the same transaction,
-- and stops with every row listed when there is any; nothing of revision 8 is applied.

create temp table sphica_migration_stop (rule text, item text);

-- Projects whose keys become one once normalized. Merging two projects that both hold rows would move sessions, whose ids derive from the
-- project id, so this revision merges only when at most one of them holds any row.
create temp table sphica_project_use as
select id, key,
  case when lower(host) = 'github.com' then lower(key) else 'git:' || lower(host) || substr(key, length(host) + 5) end as normal,
  (select count(*) from session where project_id = p.id) as sessions,
  (select count(*) from source where project_id = p.id) as sources,
  (select count(*) from artifact_link where project_id = p.id) as links,
  (select count(*) from forget_batch where project_id = p.id) as forgets,
  (select count(*) from source_forgotten where project_id = p.id) as forgotten,
  (select count(*) from extraction_run where project_id = p.id) as runs,
  (select count(*) from unit where project_id = p.id) as units,
  (select count(*) from field_def where project_id = p.id) as fields,
  (select count(*) from work where project_id = p.id) as works
from (select id, key, case when instr(substr(key, 5), '/') = 0 then substr(key, 5)
    else substr(key, 5, instr(substr(key, 5), '/') - 1) end as host from project where key glob 'git:*') p;

insert into sphica_migration_stop
select 'projects with records whose keys become one once normalized', 'project ' || id || ' ' || key || ' (becomes ' || normal || '): '
  || sessions || ' sessions, ' || sources || ' sources, ' || links || ' artifact links, ' || forgets || ' forget batches, '
  || forgotten || ' forgotten sources, ' || runs || ' runs, ' || units || ' records, ' || fields || ' fields, ' || works || ' work items'
from sphica_project_use
where sessions + sources + links + forgets + forgotten + runs + units + fields + works > 0
  and normal in (select normal from sphica_project_use
    where sessions + sources + links + forgets + forgotten + runs + units + fields + works > 0 group by normal having count(*) > 1)
order by normal, id;

drop table temp.sphica_project_use;
