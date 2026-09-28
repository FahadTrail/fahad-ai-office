-- V4.1: [free-only] is routing metadata, not message text.
--
-- The marker keeps one objective on free routes. It is now stored as
-- jobs.free_only and removed from the request text Fahad sees (chat history,
-- project views, titles, Telegram). Additive: a new column with a default,
-- plus a one-time cleanup of the rows that carried the marker in their text.

alter table public.jobs
  add column free_only boolean not null default false;

comment on column public.jobs.free_only is
  'The objective may only use free/included/promo model routes ([free-only] marker). Narrows routing; never widens it.';

update public.jobs
set
  free_only = true,
  goal = btrim(regexp_replace(regexp_replace(goal, '\[(free-only|مجاني فقط)\]', ' ', 'gi'), '[ \t]{2,}', ' ', 'g')),
  title = btrim(regexp_replace(regexp_replace(title, '\[(free-only|مجاني فقط)\]', ' ', 'gi'), '[ \t]{2,}', ' ', 'g'))
where goal ~* '\[(free-only|مجاني فقط)\]' or title ~* '\[(free-only|مجاني فقط)\]';
