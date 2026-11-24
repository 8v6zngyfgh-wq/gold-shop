-- GOLD SHOP initial database schema.
-- Run this file in Supabase SQL Editor.
-- RLS is enabled and no public policies are created here.
-- Server-side access uses SUPABASE_SECRET_KEY; never expose it in the browser.

create extension if not exists pgcrypto;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  description text not null default '',
  price numeric(12, 2) not null check (price >= 0),
  old_price numeric(12, 2) check (old_price is null or old_price >= 0),
  category text not null default 'other',
  images text[] not null default '{}',
  sizes text[] not null default '{}',
  stock jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint,
  customer_name text not null,
  phone text not null,
  city text not null,
  delivery_method text not null default 'unknown',
  delivery_address text not null default '',
  comment text not null default '',
  status text not null default 'new',
  total numeric(12, 2) not null check (total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  selected_size text not null default '',
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0)
);

create index if not exists products_active_sort_idx
  on public.products (is_active, sort_order);

create index if not exists orders_created_at_idx
  on public.orders (created_at desc);

create index if not exists orders_telegram_user_id_idx
  on public.orders (telegram_user_id);

alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
