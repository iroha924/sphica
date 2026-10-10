-- Copyright (c) 2026 iroha924 and contributors
-- SPDX-License-Identifier: MIT

-- Rows revision 9 cannot take and the migration must not change on its own. `sphica init` runs this first, inside the same transaction,
-- and stops with every row listed when there is any; nothing of revision 10 is applied.

create temp table sphica_migration_stop (rule text, item text);

-- Revision 10 lets a record mean to replace one other record only. Which of several a record meant is the owner's call, not this step's
insert into sphica_migration_stop
select 'a record that means to replace more than one other', u.key || ' supersedes ' || group_concat(t.key, ', ')
from unit_link l join unit u on u.id = l.from_unit join unit t on t.id = l.to_unit
where l.kind = 'supersedes'
group by l.from_unit having count(*) > 1;
