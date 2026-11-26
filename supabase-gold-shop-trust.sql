-- GOLD SHOP trust and order transparency
-- Additive migration. Run once in Supabase SQL Editor.
begin;

alter table public.orders
  add column if not exists tracking_number text,
  add column if not exists tracking_url text,
  add column if not exists public_order_consent boolean not null default false;

create table if not exists public.customer_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  display_name text not null,
  review_text text not null,
  photo_urls text[] not null default '{}',
  publication_consent boolean not null default false,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  constraint customer_reviews_text_length check (char_length(review_text) between 10 and 1200),
  constraint customer_reviews_name_length check (char_length(display_name) between 2 and 60)
);

create index if not exists customer_reviews_public_idx
  on public.customer_reviews (created_at desc)
  where is_published = true;

alter table public.customer_reviews enable row level security;

-- Reviews and order details are accessed only through the backend service role.
revoke all on public.customer_reviews from anon, authenticated;

commit;
