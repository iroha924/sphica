-- Copyright (c) 2026 iroha924 and contributors
-- SPDX-License-Identifier: MIT

-- Revision 13 → 14 of generation 2: a dead end can be anchored to the command it is about (unit_command), and search finds it by that
-- command. No record had one before, so the full-text index needs no rebuild. Every statement is the same as in the schema at revision 14.

create table unit_command (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  command text not null check (length(command) between 3 and 200 and command = trim(command) and command glob '* *'
    and command not glob '*  *' and command not glob '-*' and command not glob '*[''"`]*'
    and command not glob '*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*'),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at)
) strict;
create unique index unit_command_once on unit_command (unit_id, command);
create index unit_command_run on unit_command (run_id);
create trigger unit_command_check before insert on unit_command begin
  select raise(abort, 'only a dead end is anchored to a command')
  where not exists (select 1 from unit where id = new.unit_id and kind = 'dead_end');
  select raise(abort, 'command and unit belong to different projects')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
end;
create trigger unit_command_frozen before update on unit_command begin
  select raise(abort, 'a command anchor is never changed');
end;
create trigger unit_command_no_delete before delete on unit_command when exists (select 1 from unit where id = old.unit_id) begin
  select raise(abort, 'a command anchor goes only with its record');
end;

create trigger unit_rev_command_i after insert on unit_command begin update unit set revision = revision + 1 where id = new.unit_id; end;

drop view unit_search_text;
create view unit_search_text as
select u.id,
  sphica_terms(u.text || char(10) || coalesce(u.why, '') || char(10) || coalesce(u.scope_note, '') || char(10)
    || coalesce(u.revisit_when, '') || char(10)
    || coalesce((select group_concat(o.text || ' ' || coalesce(o.why, '') || ' ' || coalesce(o.reconsider_when, ''), char(10))
      from (select text, why, reconsider_when from unit_option where unit_id = u.id order by position) o), '') || char(10)
    || coalesce((select group_concat(f.name || ' ' || f.value, char(10))
      from (select d.name, v.value from unit_field v join field_def d on d.id = v.field_def_id where v.unit_id = u.id order by v.id) f), ''))
    as body,
  sphica_terms(coalesce((select group_concat(a.path || ' ' || coalesce(a.symbol, ''), char(10))
    from (select path, symbol from unit_anchor where unit_id = u.id and retired_at is null order by id) a), '') || char(10)
    || coalesce((select group_concat(c.command, char(10)) from (select command from unit_command where unit_id = u.id order by id) c), ''))
    as ident,
  sphica_terms(coalesce((select group_concat(j.value, ' ')
    from json_each((select terms from unit_alias where unit_id = u.id and content_hash = u.content_hash order by id desc limit 1)) j), ''))
    as alias
from unit u;

create trigger unit_fts_command_i after insert on unit_command begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;

pragma user_version = 14;
