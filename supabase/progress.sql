-- Brussels Flat Review: where each shortlisted flat stands (contacted, heard back, viewing, ...).
-- Run this once in the Supabase SQL editor, after schema.sql.
-- Every step is a new row; the app shows the latest one per flat, and the full history.

create table if not exists public.progress (
  id uuid primary key default gen_random_uuid(),
  flat_id text not null check (char_length(flat_id) between 1 and 64),
  stage text not null check (stage in ('to_contact', 'contacted', 'heard_back', 'viewing', 'viewed', 'applied', 'signed', 'dropped')),
  note text not null default '' check (char_length(note) <= 500),
  happens_at text not null default '' check (char_length(happens_at) <= 40),
  reviewer_id uuid not null,
  reviewer_name text not null check (char_length(reviewer_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create index if not exists progress_flat_created on public.progress (flat_id, created_at);

-- Same access as reviews: visitors can read every step and add new ones, never edit or delete.
alter table public.progress enable row level security;

drop policy if exists "Anyone can read progress" on public.progress;
create policy "Anyone can read progress" on public.progress
  for select to anon, authenticated using (true);

drop policy if exists "Anyone can add progress" on public.progress;
create policy "Anyone can add progress" on public.progress
  for insert to anon, authenticated with check (created_at > now() - interval '1 minute');

grant select, insert on public.progress to anon, authenticated;

-- Make the website's API see the new table right away
notify pgrst, 'reload schema';
