-- Copyright (c) 2026 iroha924 and contributors
-- SPDX-License-Identifier: MIT

-- Revision 12 → 13 of generation 2: a withdrawal an answer caused keeps the record that answered (unit_answer). Earlier withdrawals name
-- the answer only in their reason, so each is copied when exactly one record its run saved has the key the reason names; the others are
-- listed and left without a row. Every statement that stays is the same as in the schema at revision 13.

create temp table sphica_migration_note (rule text, item text, action text);

create table unit_answer (
  state_id integer primary key not null references unit_state (id) on delete cascade,
  answer_unit integer not null references unit (id) on delete cascade
) strict;
create index unit_answer_unit on unit_answer (answer_unit);
create trigger unit_answer_check before insert on unit_answer begin
  select raise(abort, 'an answer is written for the withdrawal of a question')
  where not exists (select 1 from unit_state t join unit q on q.id = t.unit_id
    where t.id = new.state_id and t.to_state = 'withdrawn' and q.kind = 'question');
  select raise(abort, 'a question does not answer another')
  where (select kind from unit where id = new.answer_unit) is 'question';
  select raise(abort, 'answer and question belong to different projects')
  where (select project_id from unit where id = new.answer_unit)
    is not (select q.project_id from unit_state t join unit q on q.id = t.unit_id where t.id = new.state_id);
  select raise(abort, 'a question is closed by a record the withdrawal''s own run saved')
  where (select run_id from unit where id = new.answer_unit) is not (select run_id from unit_state where id = new.state_id);
end;
create trigger unit_answer_frozen before update on unit_answer begin
  select raise(abort, 'an answer is never changed');
end;
create trigger unit_answer_no_delete before delete on unit_answer
when exists (select 1 from unit_state where id = old.state_id) and exists (select 1 from unit where id = old.answer_unit) begin
  select raise(abort, 'an answer goes only with its withdrawal or its record');
end;

-- The reason is compared with whole keys, not cut at a separator: a key's own characters cannot end it early. substr, not like, since
-- a key's _ would match any character there. Only pairs the insert trigger accepts are picked, so the copy never stops the migration
insert into unit_answer (state_id, answer_unit)
select t.id, min(a.id)
from unit_state t
join unit q on q.id = t.unit_id
join unit a on a.project_id = q.project_id and a.run_id = t.run_id and a.kind <> 'question'
  and (t.reason = 'answered by ' || a.key
    or substr(t.reason, 1, length('answered by ' || a.key || ' (through ')) = 'answered by ' || a.key || ' (through ')
where t.to_state = 'withdrawn' and q.kind = 'question'
group by t.id
having count(*) = 1;

insert into sphica_migration_note
select 'a withdrawal whose reason names an answer, with no single record of its save to match', q.key || ' (state ' || t.id || ')',
  'left without its answer; a timeline of the answering record does not tell this withdrawal'
from unit_state t join unit q on q.id = t.unit_id
where t.to_state = 'withdrawn' and substr(t.reason, 1, 12) = 'answered by '
  and not exists (select 1 from unit_answer w where w.state_id = t.id)
order by t.id;

pragma user_version = 13;
