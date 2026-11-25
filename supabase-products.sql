-- GOLD SHOP catalog + inventory migration
-- Run the whole script in Supabase SQL Editor. Safe to rerun: products upsert by slug.

alter table public.products add column if not exists variants jsonb not null default '[]'::jsonb;
alter table public.order_items add column if not exists selected_color text not null default '';
alter table public.orders add column if not exists contact_method text not null default 'phone';

create or replace function public.reserve_product_variants(p_items jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare
 item jsonb; product_row public.products%rowtype; variant_index integer;
 available integer; requested integer; color_name text; size_name text; updated_variants jsonb;
begin
 if jsonb_typeof(p_items)<>'array' then raise exception 'Invalid reservation payload'; end if;
 for item in select value from jsonb_array_elements(p_items) loop
  color_name:=item->>'color'; size_name:=item->>'size'; requested:=(item->>'quantity')::integer;
  if requested<1 or color_name is null or size_name is null then raise exception 'Invalid reservation item'; end if;
  select * into product_row from public.products where id=(item->>'product_id')::uuid and is_active=true for update;
  if not found then raise exception 'Product unavailable'; end if;
  updated_variants:=product_row.variants; variant_index:=null; available:=0;
  for variant_index in
   select ordinality::integer-1 from jsonb_array_elements(updated_variants) with ordinality as v(value,ordinality)
   where value->>'color'=color_name
  loop
   available:=coalesce((updated_variants->variant_index->'sizes'->>size_name)::integer,0); exit;
  end loop;
  if variant_index is null or available<requested then
   raise exception 'Insufficient stock for product %, color %, size %',product_row.name,color_name,size_name;
  end if;
  updated_variants:=jsonb_set(updated_variants,array[variant_index::text,'sizes',size_name],to_jsonb(available-requested),false);
  update public.products set variants=updated_variants,updated_at=now() where id=product_row.id;
 end loop;
end; $$;
revoke all on function public.reserve_product_variants(jsonb) from public,anon,authenticated;
grant execute on function public.reserve_product_variants(jsonb) to service_role;

insert into public.products(name,slug,description,price,category,images,sizes,variants,is_active,sort_order)
values
('MERTRA Puffer','mertra-puffer','Пуховик MERTRA. Чёрный цвет. Размер L.',4990,'outerwear',array['https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-01.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-02.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-03.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-04.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-05.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-06.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-07.webp.PNG'],array['L'],'[{"color":"Чёрный","images":["https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-01.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-02.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-03.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-04.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-05.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-06.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/MERTRA/mertra-07.webp.PNG"],"sizes":{"L":3}}]'::jsonb,true,1),
('Broken Planet Zip Hoodie','broken-planet-zip-hoodie','Зип-худи Broken Planet в расцветке камуфляж.',2290,'hoodies',array['https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/BROKEN%20PLANET/broken-planet-01.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/BROKEN%20PLANET/broken-planet-02.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/BROKEN%20PLANET/broken-planet-03.webp.PNG'],array['M','S'],'[{"color":"Камуфляж","images":["https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/BROKEN%20PLANET/broken-planet-01.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/BROKEN%20PLANET/broken-planet-02.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/BROKEN%20PLANET/broken-planet-03.webp.PNG"],"sizes":{"M":1,"S":1}}]'::jsonb,true,2),
('CP Company Vest','cp-company-vest','Жилетка CP Company. Доступны чёрный и белый цвета.',1990,'vests',array['https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company.png','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-01.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-02.png','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-03.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-04.png'],array['M','S'],'[{"color":"Чёрный","images":["https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company.png","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-01.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-02.png","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-03.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-04.png"],"sizes":{"M":1,"S":2}},{"color":"Белый","images":["https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company.png","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-01.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-02.png","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-03.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/CP%20COMPANY/cp-company-04.png"],"sizes":{"M":2,"S":3}}]'::jsonb,true,3),
('Gallery Dept Jeans — Yellow','gallery-dept-yellow-jeans','Жёлтые джинсы Gallery Dept.',1490,'jeans',array['https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28yellow%29/gallery-yellow-01.webp.png','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28yellow%29/gallery-yellow-02.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28yellow%29/gallery-yellow-03.webp.PNG'],array['L','M'],'[{"color":"Жёлтый","images":["https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28yellow%29/gallery-yellow-01.webp.png","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28yellow%29/gallery-yellow-02.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28yellow%29/gallery-yellow-03.webp.PNG"],"sizes":{"L":2,"M":1}}]'::jsonb,true,4),
('Gallery Dept Jeans — Black','gallery-dept-black-jeans','Чёрные джинсы Gallery Dept в крапинку.',1990,'jeans',array['https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28black%29/gallery-black-01.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28black%29/gallery-black-02.webp.PNG','https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28black%29/gallery-black-03.webp.PNG'],array['M','L'],'[{"color":"Чёрный","images":["https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28black%29/gallery-black-01.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28black%29/gallery-black-02.webp.PNG","https://dbbvnflckimugbaxkfac.supabase.co/storage/v1/object/public/product-images/GALLERY%20DEPT%20%28black%29/gallery-black-03.webp.PNG"],"sizes":{"M":1,"L":1}}]'::jsonb,true,5)
on conflict(slug) do update set
 name=excluded.name,description=excluded.description,price=excluded.price,category=excluded.category,
 images=excluded.images,sizes=excluded.sizes,variants=excluded.variants,is_active=true,
 sort_order=excluded.sort_order,updated_at=now();
