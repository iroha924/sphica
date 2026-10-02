-- Revision 8 → 9 of generation 2: search terms also hold the parts of camelCase and snake_case identifiers, so both full-text indexes
-- are rebuilt with the current rules, as `sphica doctor --reindex` does. No table, view, or trigger changes.

insert into unit_fts (unit_fts) values ('delete-all');
insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text;
insert into source_fts (source_fts) values ('delete-all');
insert into source_fts (rowid, lexemes) select id, sphica_terms(text) from source where indexed = 1;

pragma user_version = 9;
