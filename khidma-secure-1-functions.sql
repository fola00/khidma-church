-- ============================================================
-- خِدمة — SECURITY STEP 1 of 2: create the secure functions
-- Safe to run while the old app is still live (nothing is locked yet).
-- Run in Supabase → SQL Editor.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---- Director account (the password is stored HASHED, never in the app files) ----
create table if not exists director_auth (
  email     text primary key,
  pass_hash text not null
);
alter table director_auth enable row level security;      -- no policies = unreachable from the app
revoke all on director_auth from anon, authenticated;

-- >>> EDIT THESE TWO LINES: your Director email + a NEW strong password (10+ characters) <<<
do $$
declare
  v_email text := 'director@khidma.app';
  v_pass  text := 'PUT-YOUR-NEW-PASSWORD-HERE';
begin
  if v_pass = 'PUT-YOUR-NEW-PASSWORD-HERE' or length(v_pass) < 10 then
    raise exception 'Edit v_pass first: choose your own password of at least 10 characters.';
  end if;
  insert into director_auth (email, pass_hash)
  values (lower(v_email), extensions.crypt(v_pass, extensions.gen_salt('bf')))
  on conflict (email) do update set pass_hash = excluded.pass_hash;
end $$;

-- ---- internal check (not callable from the app) ----
create or replace function _director_ok(p_email text, p_pass text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean;
begin
  select exists(
    select 1 from director_auth
    where email = lower(coalesce(p_email,''))
      and pass_hash = extensions.crypt(coalesce(p_pass,''), pass_hash)
  ) into ok;
  if not ok then perform pg_sleep(0.7); end if;   -- slows down password guessing
  return ok;
end $$;
revoke execute on function _director_ok(text, text) from public, anon, authenticated;

-- ---- church data: read / write ONE church by its code (no listing, no deleting) ----
create or replace function get_church(p_code text) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('data', data, 'updated_at', updated_at)
  from app_state
  where code = p_code and code <> '__director__';
$$;

create or replace function save_church(p_code text, p_data jsonb, p_updated timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_code is null or p_code = '__director__' then return false; end if;
  if coalesce(jsonb_typeof(p_data->'users'), '') <> 'array'
     or jsonb_array_length(p_data->'users') = 0 then return false; end if;   -- never accept an empty/wiped church
  update app_state set data = p_data, updated_at = coalesce(p_updated, now()) where code = p_code;
  return found;
end $$;

-- ---- Director broadcast messages (readable by every church) ----
create or replace function get_global_news() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce((select data->'globalNews' from app_state where code = '__director__'), '[]'::jsonb);
$$;

-- ---- Director-only functions (require the Director email + password) ----
create or replace function director_login(p_email text, p_pass text) returns boolean
language sql security definer set search_path = public, extensions as $$
  select _director_ok(p_email, p_pass);
$$;

create or replace function director_get(p_email text, p_pass text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not _director_ok(p_email, p_pass) then raise exception 'unauthorized'; end if;
  return coalesce((select data from app_state where code = '__director__'), '{}'::jsonb);
end $$;

create or replace function director_save(p_email text, p_pass text, p_data jsonb) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not _director_ok(p_email, p_pass) then raise exception 'unauthorized'; end if;
  insert into app_state (code, data, updated_at) values ('__director__', p_data, now())
  on conflict (code) do update set data = excluded.data, updated_at = now();
  return true;
end $$;

create or replace function director_create_church(p_email text, p_pass text, p_code text, p_data jsonb) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not _director_ok(p_email, p_pass) then raise exception 'unauthorized'; end if;
  if p_code is null or p_code = '__director__' or length(p_code) < 4 then raise exception 'bad code'; end if;
  insert into app_state (code, data, updated_at) values (p_code, p_data, now())
  on conflict (code) do update set data = excluded.data, updated_at = now();
  return true;
end $$;

create or replace function director_delete_church(p_email text, p_pass text, p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not _director_ok(p_email, p_pass) then raise exception 'unauthorized'; end if;
  if p_code is null or p_code = '__director__' then raise exception 'bad code'; end if;
  delete from app_state where code = p_code;
  return true;
end $$;

grant execute on function
  get_church(text), save_church(text, jsonb, timestamptz), get_global_news(),
  director_login(text, text), director_get(text, text), director_save(text, text, jsonb),
  director_create_church(text, text, text, jsonb), director_delete_church(text, text, text)
to anon, authenticated;

notify pgrst, 'reload schema';
