-- Brussels Flat Review: allow "super yes" votes.
-- Run this once in the Supabase SQL Editor (the reviews table from schema.sql must exist).

alter table public.reviews drop constraint if exists reviews_verdict_check;
alter table public.reviews add constraint reviews_verdict_check
  check (verdict in ('yes', 'super', 'no', 'none'));

notify pgrst, 'reload schema';
