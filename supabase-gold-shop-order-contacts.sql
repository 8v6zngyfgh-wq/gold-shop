-- GOLD SHOP: buyer email for delivery coordination.
alter table public.orders
  add column if not exists email text;
