-- Daily Work Portal — database setup.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run again.
-- It contains NO staff names. The staff list is added separately from a private file.

-- 1. Staff list. Names and emails live only here, never in the public code.
create table if not exists public.people (
  id        text primary key,                 -- short key, e.g. 'p01'
  name      text not null,
  title     text not null default '',
  role      text not null check (role in ('CEO','General Manager','Manager','Staff')),
  managers  text[] not null default '{}',     -- ids of the people this person reports to
  email     text unique,                      -- the email they log in with
  is_field  boolean not null default false,   -- sales staff: location login before 09:00, meetings
  phone     text,
  user_id   uuid unique references auth.users(id) on delete set null
);

-- 2. Shared work: tasks, closure reports, meetings, notifications, attendance times.
create table if not exists public.records (
  collection text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (collection, id)
);

-- 3. GPS locations. Only the CEO and the General Manager can read these.
create table if not exists public.locations (
  id          bigint generated always as identity primary key,
  person      text not null references public.people(id),
  kind        text not null,          -- login | visit | meeting
  ref         text,                   -- the attendance record id or meeting id
  lat         double precision not null,
  lng         double precision not null,
  acc         double precision,
  gps_time    text,
  device_time text,
  gps_diff    integer,
  created_at  timestamptz not null default now()
);
create index if not exists locations_ref_idx on public.locations(ref);

alter table public.people add column if not exists phone text;
alter table public.people add column if not exists sort integer;   -- organisation chart order

-- Keep updated_at current.
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before update on public.records for each row execute function public.touch_updated_at();

-- Helpers.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from people where user_id = auth.uid())
$$;
create or replace function public.is_management() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from people where user_id = auth.uid() and role in ('CEO','General Manager'))
$$;
-- Links a login account to its staff row (matched by email) on first login.
create or replace function public.link_me() returns public.people
language plpgsql security definer set search_path = public as $$
declare p people;
begin
  update people set user_id = auth.uid()
   where user_id is null and lower(email) = lower(auth.jwt() ->> 'email')
  returning * into p;
  if p.id is null then select * into p from people where user_id = auth.uid(); end if;
  return p;
end $$;
-- Used only by the reminder service to mark which emails were sent.
create or replace function public.set_email_sent(mid text, sent jsonb) returns void
language sql security definer set search_path = public as $$
  update records set data = jsonb_set(data, '{emailSent}', sent, true) where collection = 'meetings' and id = mid
$$;
revoke execute on function public.set_email_sent(text, jsonb) from public, anon, authenticated;

-- Private settings, readable only by the server (not exposed to the website).
create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('cron_secret', encode(gen_random_bytes(24), 'hex')) on conflict (key) do nothing;
create or replace function public.check_cron_secret(s text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.settings where key = 'cron_secret' and value = s)
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;

-- Security rules (row-level security).
alter table public.people    enable row level security;
alter table public.records   enable row level security;
alter table public.locations enable row level security;

drop policy if exists "staff read people" on public.people;
create policy "staff read people" on public.people for select to authenticated using (true);

drop policy if exists "staff read records"   on public.records;
drop policy if exists "staff add records"    on public.records;
drop policy if exists "staff change records" on public.records;
drop policy if exists "staff delete records" on public.records;
create policy "staff read records"   on public.records for select to authenticated using (public.is_staff());
create policy "staff add records"    on public.records for insert to authenticated with check (public.is_staff());
create policy "staff change records" on public.records for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staff delete records" on public.records for delete to authenticated using (public.is_staff());

drop policy if exists "save own location"         on public.locations;
drop policy if exists "management reads locations" on public.locations;
create policy "save own location" on public.locations for insert to authenticated
  with check (person = (select id from public.people where user_id = auth.uid()));
create policy "management reads locations" on public.locations for select to authenticated
  using (public.is_management());

-- Table access for logged-in users (the security rules above still decide which rows).
grant usage on schema public to authenticated;
grant select on public.people to authenticated;
grant select, insert, update, delete on public.records to authenticated;
grant select, insert on public.locations to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke execute on function public.is_staff(), public.is_management(), public.link_me() from public, anon;
grant execute on function public.is_staff(), public.is_management(), public.link_me() to authenticated;
revoke all on public.people, public.records, public.locations from anon;

-- Live updates in the portal.
do $$ begin
  begin alter publication supabase_realtime add table public.records;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.locations; exception when duplicate_object then null; end;
end $$;
