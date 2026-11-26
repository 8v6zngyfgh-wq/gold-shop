-- GOLD SHOP: buyer email for delivery coordination.
alter table public.orders
  add column if not exists email text;

alter table public.orders
  drop constraint if exists orders_email_format_check;

alter table public.orders
  add constraint orders_email_format_check
  check (email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$');
