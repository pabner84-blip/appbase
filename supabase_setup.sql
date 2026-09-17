-- =========================================================================
--   STOCKFERRE -> SUPABASE (esquema de la nube)
--   CÓMO USARLO:
--     1. En tu proyecto Supabase abre el menú SQL Editor (izquierda).
--     2. Pega TODO este archivo en el editor.
--     3. Presiona "Run" (ejecutar).
--   Si algo ya existía de una corrida anterior, los "create table if not
--   exists" / "create or replace" no rompen nada (idempotente).
-- =========================================================================

-- -------------------------------------------------------------------------
--  TABLAS
--  Cada colección de Firestore ahora es una tabla. El campo "payload"
--  (jsonb) guarda el objeto EXACTO que la app ya usa (producto, venta,
--  ajuste, gasto...), así la migración no obliga a cambiar el formato.
--  "modo" separa dominios: manual / electrico / invitado (igual que las
--  antiguas colecciones stockferre_*_<modo>).
-- -------------------------------------------------------------------------

create table if not exists public.meta (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000)
);

create table if not exists public.productos (
  id text not null,
  modo text not null,
  payload jsonb not null default '{}'::jsonb,
  stock numeric not null default 0,
  updated_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000),
  primary key (id, modo)
);

create table if not exists public.ventas (
  id text not null,
  modo text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000),
  primary key (id, modo)
);

create table if not exists public.ajustes (
  id text not null,
  modo text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000),
  primary key (id, modo)
);

create table if not exists public.gastos_prestamos (
  id text not null,
  modo text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000),
  primary key (id, modo)
);

-- Mantiene la columna "stock" sincronizada con payload.stock (solo cuando el
-- payload trae la clave stock; si no la trae, respeta el stock existente).
create or replace function public.sync_producto_stock()
returns trigger
language plpgsql
as $$
begin
  if new.payload ? 'stock' then
    new.stock := coalesce((new.payload->>'stock')::numeric, 0);
  end if;
  if new.payload ? '_updatedAt' then
    new.updated_at := coalesce((new.payload->>'_updatedAt')::bigint, new.updated_at);
  end if;
  return new;
end $$;

drop trigger if exists trg_productos_sync on public.productos;
create trigger trg_productos_sync
  before insert or update on public.productos
  for each row execute function public.sync_producto_stock();

-- Igual para ventas/ajustes/gastos: actualiza updated_at desde payload._ts.
create or replace function public.sync_ts_generic()
returns trigger
language plpgsql
as $$
begin
  if new.payload ? '_ts' then
    new.updated_at := coalesce((new.payload->>'_ts')::bigint, new.updated_at);
  end if;
  return new;
end $$;

drop trigger if exists trg_ventas_sync on public.ventas;
create trigger trg_ventas_sync
  before insert or update on public.ventas
  for each row execute function public.sync_ts_generic();

drop trigger if exists trg_ajustes_sync on public.ajustes;
create trigger trg_ajustes_sync
  before insert or update on public.ajustes
  for each row execute function public.sync_ts_generic();

drop trigger if exists trg_gp_sync on public.gastos_prestamos;
create trigger trg_gp_sync
  before insert or update on public.gastos_prestamos
  for each row execute function public.sync_ts_generic();

-- -------------------------------------------------------------------------
--  FUNCIONES RPC (reemplazan a FieldValue.increment de Firestore)
-- -------------------------------------------------------------------------

-- Incremento ATÓMICO de stock: si dos celulares suman a la vez, Postgres
-- suma ambas cantidades (ninguna se pierde). Si el producto no existe aún,
-- lo crea con la información que manda la app (sin pisar stock ajeno).
-- Devuelve el stock NUEVO (la fuente de verdad) para que la app lo aplique.
create or replace function public.inc_stock(
  p_id text, p_modo text, p_delta numeric, p_payload jsonb
)
returns numeric
language plpgsql
as $$
declare
  cur numeric;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  insert into public.productos (id, modo, stock, payload)
  values (p_id, p_modo, 0, coalesce(p_payload, '{}'::jsonb))
  on conflict (id, modo) do nothing;

  update public.productos
    set stock = stock + p_delta,
        payload = jsonb_set(
                    jsonb_set(payload, '{stock}', to_jsonb(stock + p_delta), true),
                    '{_updatedAt}', to_jsonb(now_ms), true
                  ),
        updated_at = now_ms
  where id = p_id and modo = p_modo
  returning stock into cur;

  return coalesce(cur, p_delta);
end $$;

-- Crea un producto si no existe, o FUSIONA los campos que trae el payload
-- con los que ya hay en la nube (igual que el "merge: true" de Firestore).
-- NUNCA toca el stock si el payload no lo trae.
create or replace function public.ensure_producto(
  p_id text, p_modo text, p_payload jsonb
)
returns void
language plpgsql
as $$
begin
  insert into public.productos (id, modo, stock, payload)
  values (p_id, p_modo, 0, coalesce(p_payload, '{}'::jsonb))
  on conflict (id, modo) do update set
    payload = public.productos.payload || excluded.payload;
end $$;

-- -------------------------------------------------------------------------
--  SEGURIDAD (RLS)
--  Mismo modelo de confianza que tenía la app en Firebase (modo prueba):
--  cualquiera con la anon key de este proyecto puede leer/escribir.
-- -------------------------------------------------------------------------

alter table public.meta enable row level security;
alter table public.productos enable row level security;
alter table public.ventas enable row level security;
alter table public.ajustes enable row level security;
alter table public.gastos_prestamos enable row level security;

drop policy if exists "anon_full_access" on public.meta;
create policy "anon_full_access" on public.meta for all using (true) with check (true);

drop policy if exists "anon_full_access" on public.productos;
create policy "anon_full_access" on public.productos for all using (true) with check (true);

drop policy if exists "anon_full_access" on public.ventas;
create policy "anon_full_access" on public.ventas for all using (true) with check (true);

drop policy if exists "anon_full_access" on public.ajustes;
create policy "anon_full_access" on public.ajustes for all using (true) with check (true);

drop policy if exists "anon_full_access" on public.gastos_prestamos;
create policy "anon_full_access" on public.gastos_prestamos for all using (true) with check (true);

-- PERMISOS BASE (GRANT): la RLS decide QUÉ filas ve/escribe cada rol, pero los
-- roles de la API (anon / authenticated) también necesitan el GRANT de la
-- tabla para poder tocar algo. Sin esto da error 42501 "permission denied".
grant select, insert, update, delete on public.meta to anon, authenticated;
grant select, insert, update, delete on public.productos to anon, authenticated;
grant select, insert, update, delete on public.ventas to anon, authenticated;
grant select, insert, update, delete on public.ajustes to anon, authenticated;
grant select, insert, update, delete on public.gastos_prestamos to anon, authenticated;

-- Las funciones RPC (inc_stock / ensure_producto) también se ejecutan con el
-- rol anon, así que necesitan permiso de ejecución.
grant execute on function public.inc_stock(text, text, numeric, jsonb) to anon, authenticated;
grant execute on function public.ensure_producto(text, text, jsonb) to anon, authenticated;

-- -------------------------------------------------------------------------
--  REALTIME
--  Habilita la replicación de cambios a los clientes (reemplaza al
--  onSnapshot de Firestore). Se publican todas las tablas sincronizadas.
-- -------------------------------------------------------------------------

-- Realtime entrega la fila BORRADA (o la anterior a un UPDATE) solo si la
-- tabla tiene REPLICA IDENTITY FULL. Sin esto, un borrado de ajuste/gasto no
-- llegaría a los otros celulares. No afecta a la app, solo a la replicación.
alter table public.meta replica identity full;
alter table public.productos replica identity full;
alter table public.ventas replica identity full;
alter table public.ajustes replica identity full;
alter table public.gastos_prestamos replica identity full;

-- Los "alter publication add table" directos fallan si se corre el script por
-- segunda vez (error 42710 "already member"). Este bloque solo agrega las
-- tablas que todavía no están PUBLICADAS al tiempo real (idempotente).
do $$
declare
  t text;
begin
  foreach t in array array['meta','productos','ventas','ajustes','gastos_prestamos']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;