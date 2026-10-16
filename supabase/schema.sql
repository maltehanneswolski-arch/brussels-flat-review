-- Brussels Flat Review: shared Yes/No votes and comments.
-- Run this once in the Supabase SQL editor of a new project.
-- Every vote or comment is a new row; the app shows each person's latest row per flat.

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  flat_id text not null check (char_length(flat_id) between 1 and 64),
  reviewer_id uuid not null,
  reviewer_name text not null check (char_length(reviewer_name) between 1 and 40),
  verdict text not null check (verdict in ('yes', 'no', 'none')),
  comment text not null default '' check (char_length(comment) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists reviews_flat_created on public.reviews (flat_id, created_at);

-- Visitors can read all reviews and add new ones. Nobody can edit or delete
-- through the public key; clean up from the Supabase dashboard if needed.
alter table public.reviews enable row level security;

drop policy if exists "Anyone can read reviews" on public.reviews;
create policy "Anyone can read reviews" on public.reviews
  for select to anon, authenticated using (true);

drop policy if exists "Anyone can add a review" on public.reviews;
create policy "Anyone can add a review" on public.reviews
  for insert to anon, authenticated with check (created_at > now() - interval '1 minute');

grant select, insert on public.reviews to anon, authenticated;
