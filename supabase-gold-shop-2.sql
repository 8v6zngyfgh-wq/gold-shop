-- GOLD SHOP 2.0 database migration
-- Run once in Supabase SQL Editor after reviewing the project backup.
-- This migration is additive: it does not delete or rewrite existing products or orders.

begin;

alter table public.products
  add column if not exists cost_price numeric(12, 2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_cost_price_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_cost_price_nonnegative
      check (cost_price is null or cost_price >= 0);
  end if;
end $$;

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  color text not null default '',
  size text not null default '',
  quantity_change integer not null check (quantity_change <> 0),
  reason text not null,
  order_id uuid references public.orders(id) on delete set null,
  idempotency_key text unique,
  actor_telegram_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_created_at_idx
  on public.inventory_movements (created_at desc);
create index if not exists inventory_movements_product_idx
  on public.inventory_movements (product_id, created_at desc);
create index if not exists inventory_movements_order_idx
  on public.inventory_movements (order_id);

create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  previous_status text,
  new_status text not null,
  actor_telegram_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists order_status_history_order_idx
  on public.order_status_history (order_id, created_at desc);

alter table public.inventory_movements enable row level security;
alter table public.order_status_history enable row level security;

create or replace function public.change_order_status_and_restore_inventory(
  p_order_id uuid,
  p_new_status text,
  p_actor_telegram_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_variants jsonb;
  v_variant_index integer;
  v_current integer;
  v_movement_id uuid;
begin
  if p_new_status not in ('new', 'confirmed', 'shipped', 'completed', 'cancelled') then
    raise exception 'Invalid order status';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Order not found';
  end if;

  if v_order.status = p_new_status then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'unchanged', true);
  end if;

  if v_order.status = 'cancelled' and p_new_status <> 'cancelled' then
    raise exception 'Cancelled orders cannot be reopened automatically';
  end if;

  update public.orders
  set status = p_new_status, updated_at = now()
  where id = p_order_id;

  insert into public.order_status_history (
    order_id, previous_status, new_status, actor_telegram_id
  ) values (
    p_order_id, v_order.status, p_new_status, p_actor_telegram_id
  );

  if p_new_status = 'cancelled' then
    for v_item in
      select product_id, product_name, selected_color, selected_size, quantity
      from public.order_items
      where order_id = p_order_id
    loop
      if v_item.product_id is null
        or coalesce(v_item.selected_color, '') = ''
        or coalesce(v_item.selected_size, '') = '' then
        continue;
      end if;

      select coalesce(variants, '[]'::jsonb)
      into v_variants
      from public.products
      where id = v_item.product_id
      for update;

      if not found then
        continue;
      end if;

      select ordinality::integer - 1
      into v_variant_index
      from jsonb_array_elements(v_variants) with ordinality as variant(value, ordinality)
      where value->>'color' = v_item.selected_color
      limit 1;

      if v_variant_index is null then
        continue;
      end if;

      v_current := coalesce(
        (v_variants->v_variant_index->'sizes'->>v_item.selected_size)::integer,
        0
      );

      v_movement_id := null;
      insert into public.inventory_movements (
        product_id, product_name, color, size, quantity_change,
        reason, order_id, idempotency_key, actor_telegram_id
      ) values (
        v_item.product_id, v_item.product_name, v_item.selected_color,
        v_item.selected_size, v_item.quantity, 'order_cancelled',
        p_order_id,
        'order-cancel:' || p_order_id::text || ':' || v_item.product_id::text ||
          ':' || v_item.selected_color || ':' || v_item.selected_size,
        p_actor_telegram_id
      )
      on conflict (idempotency_key) do nothing
      returning id into v_movement_id;

      if v_movement_id is not null then
        v_variants := jsonb_set(
          v_variants,
          array[v_variant_index::text, 'sizes', v_item.selected_size],
          to_jsonb(v_current + v_item.quantity),
          true
        );
        update public.products
        set variants = v_variants, updated_at = now()
        where id = v_item.product_id;
      end if;
    end loop;
  end if;

  return jsonb_build_object('order_id', p_order_id, 'status', p_new_status, 'unchanged', false);
end;
$$;

revoke all on function public.change_order_status_and_restore_inventory(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.change_order_status_and_restore_inventory(uuid, text, bigint)
  to service_role;

commit;
