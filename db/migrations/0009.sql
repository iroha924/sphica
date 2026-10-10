-- Copyright (c) 2026 iroha924 and contributors
-- SPDX-License-Identifier: MIT

-- Both full-text indexes must hold terms() output as of revision 9, which includes the parts of camelCase and snake_case names, so they
-- are rebuilt as `sphica doctor --reindex` does. Tables, views, and triggers are the same as at revision 8.

insert into unit_fts (unit_fts) values ('delete-all');
insert into unit_fts (rowid, body, ident, alias) select id, body, ident, alias from unit_search_text;
insert into source_fts (source_fts) values ('delete-all');
insert into source_fts (rowid, lexemes) select id, sphica_terms(text) from source where indexed = 1;

pragma user_version = 9;
