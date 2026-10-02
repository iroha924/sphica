-- Revision 7 → 8 of generation 2: project keys are normalized (a git key's host in lowercase, and the whole key on github.com), and
-- triggers refuse a key that is not. Projects whose keys become one merge only when at most one holds rows (0008.check.sql stops
-- otherwise): the one with rows, or the oldest, keeps its id and takes the key; the empty others go. Runs in one transaction with foreign
-- keys off; every statement that stays matches db/schema.sql at revision 8, and server/test/migrate.test.ts compares the two.

create temp table sphica_migration_note (rule text, item text, action text);

create temp table sphica_project_normal as
select id, key, normal,
  case when instr(substr(normal, 5), '/') = 0 then substr(normal, 5)
    else substr(normal, 5 + instr(substr(normal, 5), '/')) end as name,
  exists (select 1 from session where project_id = p.id) or exists (select 1 from source where project_id = p.id)
    or exists (select 1 from artifact_link where project_id = p.id) or exists (select 1 from forget_batch where project_id = p.id)
    or exists (select 1 from source_forgotten where project_id = p.id) or exists (select 1 from extraction_run where project_id = p.id)
    or exists (select 1 from unit where project_id = p.id) or exists (select 1 from field_def where project_id = p.id)
    or exists (select 1 from work where project_id = p.id) as used
from (select id, key,
    case when lower(host) = 'github.com' then lower(key) else 'git:' || lower(host) || substr(key, length(host) + 5) end as normal
  from (select id, key, case when instr(substr(key, 5), '/') = 0 then substr(key, 5)
      else substr(key, 5, instr(substr(key, 5), '/') - 1) end as host from project where key glob 'git:*')) p;

create temp table sphica_project_keep as
select normal, coalesce(max(case when used then id end), min(id)) as id from sphica_project_normal group by normal;

-- Delete the empty others first: one of them may hold the normalized key already
insert into sphica_migration_note
select 'an empty project whose key another project takes once normalized', 'project ' || n.id || ' ' || n.key,
  'removed; project ' || k.id || ' takes ' || n.normal
from sphica_project_normal n join sphica_project_keep k on k.normal = n.normal where n.id <> k.id order by n.id;
delete from project where id in (select n.id from sphica_project_normal n join sphica_project_keep k on k.normal = n.normal where n.id <> k.id);

insert into sphica_migration_note
select 'a project key that was not normalized', 'project ' || n.id || ' ' || n.key, 'now ' || n.normal || ' (' || n.name || ')'
from sphica_project_normal n join sphica_project_keep k on k.id = n.id where n.key <> n.normal order by n.id;
update project set key = (select normal from sphica_project_normal n where n.id = project.id),
  name = (select name from sphica_project_normal n where n.id = project.id)
where id in (select n.id from sphica_project_normal n join sphica_project_keep k on k.id = n.id where n.key <> n.normal);

drop table temp.sphica_project_keep;
drop table temp.sphica_project_normal;

create trigger project_key_normal_insert before insert on project when new.key glob 'git:*' begin
  select raise(abort, 'the project key is not normalized')
  from (select rest, case when instr(rest, '/') = 0 then rest else substr(rest, 1, instr(rest, '/') - 1) end as host
    from (select substr(new.key, 5) as rest))
  where new.key is not case when lower(host) = 'github.com' then lower(new.key) else 'git:' || lower(host) || substr(rest, length(host) + 1) end;
end;
create trigger project_key_normal_update before update of key on project when new.key glob 'git:*' begin
  select raise(abort, 'the project key is not normalized')
  from (select rest, case when instr(rest, '/') = 0 then rest else substr(rest, 1, instr(rest, '/') - 1) end as host
    from (select substr(new.key, 5) as rest))
  where new.key is not case when lower(host) = 'github.com' then lower(new.key) else 'git:' || lower(host) || substr(rest, length(host) + 1) end;
end;

pragma user_version = 8;
