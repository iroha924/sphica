-- Copyright (c) 2026 iroha924 and contributors
-- SPDX-License-Identifier: MIT

-- Revision 3 → 4 of generation 2: project-defined fields (field_def) and quoted field values (unit_field).
-- `sphica init` runs this in one transaction with foreign keys off (set outside the transaction), then checks foreign_key_check before
-- committing. Every statement matches db/schema.sql at revision 4; server/test/migrate.test.ts compares a migrated database with a fresh one.

-- The search view gains field names and values. The view cannot be altered, and the triggers that read it are dropped first and created again.
drop trigger unit_fts_ai;
drop trigger unit_fts_option_i;
drop trigger unit_fts_anchor_i;
drop trigger unit_fts_anchor_u;
drop trigger unit_fts_anchor_d;
drop trigger unit_fts_alias_i;
drop trigger unit_fts_alias_d;
drop view unit_search_text;

-- A field the owner defined for this project's records (a time-boxed trial: kept only if values prove useful in search and reading). Written by trace, quoting the owner's words.
-- A name is defined once per project: redefinition is refused until the trial shows fields are worth keeping.
-- Forgetting the quoted source removes the definition and every value of it.
create table field_def (
  id integer primary key autoincrement not null,
  project_id integer not null references project (id) on delete cascade,
  name text not null check (length(name) between 1 and 40 and name glob '[a-z]*' and name not glob '*[^a-z0-9_]*'),
  type text not null check (type in ('text', 'enum', 'integer', 'date')),
  label text not null check (label <> '' and length(label) <= 100),
  description text not null check (description <> '' and length(description) <= 500),
  -- For an enum, its values (1 to 30 distinct non-empty strings of at most 100 characters)
  enum_values text check (enum_values is null or (json_valid(enum_values) and json_type(enum_values) = 'array'
    and json_array_length(enum_values) between 1 and 30)),
  -- The unit kinds the field applies to; empty means every kind
  kinds text not null default '[]' check (json_valid(kinds) and json_type(kinds) = 'array'),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  unique (project_id, name),
  check ((type = 'enum') = (enum_values is not null))
) strict;
create index field_def_source on field_def (source_id);
create trigger field_def_check before insert on field_def begin
  select raise(abort, 'a field definition, its source, and its run belong to one project')
  where new.project_id is not (select project_id from source where id = new.source_id)
     or new.project_id is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'fields are defined by trace')
  where (select origin from extraction_run where id = new.run_id) is not 'trace';
  select raise(abort, 'a field definition quotes the owner')
  where not exists (select 1 from source where id = new.source_id and author_kind = 'owner');
  select raise(abort, 'field definition span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  select raise(abort, 'enum values are distinct non-empty strings of at most 100 characters')
  where new.enum_values is not null and (exists (select 1 from json_each(new.enum_values)
      where type <> 'text' or length(trim(value)) = 0 or length(value) > 100)
    or (select count(distinct value) from json_each(new.enum_values)) <> json_array_length(new.enum_values));
  select raise(abort, 'field kinds are distinct unit kinds')
  where exists (select 1 from json_each(new.kinds) where type <> 'text'
      or value not in ('decision', 'implementation', 'finding', 'dead_end', 'question', 'constraint'))
    or (select count(distinct value) from json_each(new.kinds)) <> json_array_length(new.kinds);
end;
create trigger field_def_frozen before update on field_def begin
  select raise(abort, 'field definitions are never rewritten');
end;
create trigger field_def_no_delete before delete on field_def
when exists (select 1 from project where id = old.project_id) and exists (select 1 from source where id = old.source_id) begin
  select raise(abort, 'field definitions are removed only with their quoted source');
end;

-- A unit's value for a field, quoting where it was said. Written with the unit, before its first state, like its options; never rewritten.
-- Forgetting the quoted source (or the definition's) removes the value.
create table unit_field (
  id integer primary key autoincrement not null,
  unit_id integer not null references unit (id) on delete cascade,
  field_def_id integer not null references field_def (id) on delete cascade,
  value text not null check (value <> '' and length(value) <= 200),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  run_id integer not null references extraction_run (id),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at),
  unique (unit_id, field_def_id)
) strict;
create index unit_field_def on unit_field (field_def_id);
create index unit_field_source on unit_field (source_id);
create trigger unit_field_check before insert on unit_field begin
  select raise(abort, 'a field value, its unit, definition, source, and run belong to one project')
  where (select project_id from unit where id = new.unit_id) is not (select project_id from field_def where id = new.field_def_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from source where id = new.source_id)
     or (select project_id from unit where id = new.unit_id) is not (select project_id from extraction_run where id = new.run_id);
  select raise(abort, 'field values are written by trace')
  where (select origin from extraction_run where id = new.run_id) is not 'trace';
  select raise(abort, 'field values are written with the unit, before its first state; record a successor instead')
  where exists (select 1 from unit_state where unit_id = new.unit_id) or exists (select 1 from unit_alias where unit_id = new.unit_id);
  select raise(abort, 'field value span is outside the source text')
  where new.span_end > (select length(cast(text as blob)) from source where id = new.source_id);
  select raise(abort, 'the field does not apply to this kind of unit')
  where exists (select 1 from field_def d where d.id = new.field_def_id and json_array_length(d.kinds) > 0
    and not exists (select 1 from json_each(d.kinds) j where j.value = (select kind from unit where id = new.unit_id)));
  select raise(abort, 'an integer field value is an optional minus sign and digits')
  where (select type from field_def where id = new.field_def_id) = 'integer'
    and (new.value not glob '[0-9]*' and new.value not glob '-[0-9]*' or substr(new.value, 2) glob '*[^0-9]*');
  select raise(abort, 'a date field value is a valid YYYY-MM-DD date')
  where (select type from field_def where id = new.field_def_id) = 'date'
    and (length(new.value) <> 10 or date(new.value) is not new.value);
  select raise(abort, 'an enum field value is one of its values')
  where (select type from field_def where id = new.field_def_id) = 'enum' and not exists (select 1 from json_each(
    (select enum_values from field_def where id = new.field_def_id)) where value = new.value);
end;
create trigger unit_field_frozen before update on unit_field begin
  select raise(abort, 'field values are never rewritten; record a successor');
end;
create trigger unit_field_no_delete before delete on unit_field
when exists (select 1 from unit where id = old.unit_id) and exists (select 1 from source where id = old.source_id)
  and exists (select 1 from field_def where id = old.field_def_id) begin
  select raise(abort, 'field values are removed only with their unit or a quoted source');
end;

create trigger unit_rev_field_i after insert on unit_field begin update unit set revision = revision + 1 where id = new.unit_id; end;
create trigger unit_rev_field_d after delete on unit_field when exists (select 1 from unit where id = old.unit_id) begin
  update unit set revision = revision + 1 where id = old.unit_id;
end;
create trigger unit_fts_field_i after insert on unit_field begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_field_d after delete on unit_field when exists (select 1 from unit where id = old.unit_id) begin
  delete from unit_fts where rowid = old.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = old.unit_id;
end;
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
    from (select path, symbol from unit_anchor where unit_id = u.id and retired_at is null order by id) a), '')) as ident,
  sphica_terms(coalesce((select group_concat(j.value, ' ')
    from json_each((select terms from unit_alias where unit_id = u.id and content_hash = u.content_hash order by id desc limit 1)) j), ''))
    as alias
from unit u;
create trigger unit_fts_ai after insert on unit begin
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.id;
end;
create trigger unit_fts_option_i after insert on unit_option begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_anchor_i after insert on unit_anchor begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_anchor_u after update on unit_anchor begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_anchor_d after delete on unit_anchor when exists (select 1 from unit where id = old.unit_id) begin
  delete from unit_fts where rowid = old.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = old.unit_id;
end;
create trigger unit_fts_alias_i after insert on unit_alias begin
  delete from unit_fts where rowid = new.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = new.unit_id;
end;
create trigger unit_fts_alias_d after delete on unit_alias when exists (select 1 from unit where id = old.unit_id) begin
  delete from unit_fts where rowid = old.unit_id;
  insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text where id = old.unit_id;
end;

pragma user_version = 4;
