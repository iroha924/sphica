-- Rows revision 5 cannot take and the migration must not change on its own. `sphica init` runs this first, inside the same transaction,
-- and stops with every row listed when there is any; nothing is changed.

create temp table sphica_migration_stop (rule text, item text);

-- A file excerpt's path is part of its identity, and a source is removed only by the owner's forget
insert into sphica_migration_stop
select 'a file excerpt whose path revision 5 refuses (forget it to go on)', 'source ' || id || ' ' || external_id
from source where kind = 'file_excerpt' and not (path <> '' and path <> '.' and path <> '..' and path not glob '/*' and path not glob '[A-Za-z]:*' and path not glob '*\*'
    and path not glob '*//*' and path not glob './*' and path not glob '../*' and path not glob '*/./*' and path not glob '*/../*'
    and path not glob '*/.' and path not glob '*/..' and path not glob '*[' || char(1) || '-' || char(31) || char(127) || ']*') order by id;
