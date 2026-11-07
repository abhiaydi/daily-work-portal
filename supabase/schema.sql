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
alter table public.people add column if not exists dotted text[] not null default '{}';  -- indirect managers: their work for this person needs GM approval

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

-- Projects: Google Drive folder ids and the text read from uploaded files.
-- Server only: row-level security is on with no policies, so the browser cannot read these.
create table if not exists public.drive_folders (
  key text primary key, folder_id text not null, url text, name text, created_at timestamptz not null default now());
create table if not exists public.project_file_text (
  file_id text primary key, project_id text not null, text text not null, created_at timestamptz not null default now());
create index if not exists project_file_text_project on public.project_file_text(project_id);
alter table public.drive_folders enable row level security;
alter table public.project_file_text enable row level security;
revoke all on public.drive_folders, public.project_file_text from anon, authenticated;

-- Photo library: pictures in a private storage bucket. Any staff member can view and add; only the
-- person who added a photo (or the CEO/GM) can delete it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
drop policy if exists "staff read photos" on storage.objects;
drop policy if exists "staff add photos" on storage.objects;
drop policy if exists "remove own photos" on storage.objects;
create policy "staff read photos" on storage.objects for select to authenticated using (bucket_id = 'photos' and public.is_staff());
create policy "staff add photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos' and public.is_staff());
create policy "remove own photos" on storage.objects for delete to authenticated using (bucket_id = 'photos' and (owner_id = auth.uid()::text or public.is_management()));

-- Login / logout locations for everyone (kind = signin | open | signout). Location may be missing
-- if the person refused it; the reason goes in "note".
alter table public.locations alter column lat drop not null;
alter table public.locations alter column lng drop not null;
alter table public.locations add column if not exists note text;
alter table public.locations add column if not exists device text;
create index if not exists locations_kind_time_idx on public.locations(kind, created_at desc);

-- Login/logout TIMES (no coordinates) for a person's own dashboard, their managers, the CEO and the GM.
create or replace function public.session_times(p_person text, p_from timestamptz, p_to timestamptz)
returns table(kind text, created_at timestamptz, device text, located boolean)
language sql stable security definer set search_path = public as $$
  with recursive me as (select id, role from people where user_id = auth.uid()),
  t(id) as (
    select p.id from people p, me where me.id = any(p.managers)
    union
    select p.id from people p join t on t.id = any(p.managers)
  )
  select l.kind, l.created_at, l.device, l.lat is not null
  from locations l, me
  where l.person = p_person and l.created_at >= p_from and l.created_at < p_to
    and l.kind in ('signin','open','signout','login')
    and (p_person = me.id or me.role in ('CEO','General Manager') or p_person in (select id from t))
  order by l.created_at;
$$;
revoke execute on function public.session_times(text, timestamptz, timestamptz) from public, anon;
grant execute on function public.session_times(text, timestamptz, timestamptz) to authenticated;

-- Task attachments: private bucket. Any staff member can view and add; the uploader or the CEO/GM can delete.
insert into storage.buckets (id, name, public, file_size_limit) values ('taskfiles', 'taskfiles', false, 20971520) on conflict (id) do nothing;
drop policy if exists "staff read task files" on storage.objects;
drop policy if exists "staff add task files" on storage.objects;
drop policy if exists "remove own task files" on storage.objects;
create policy "staff read task files" on storage.objects for select to authenticated using (bucket_id = 'taskfiles' and public.is_staff());
create policy "staff add task files" on storage.objects for insert to authenticated with check (bucket_id = 'taskfiles' and public.is_staff());
create policy "remove own task files" on storage.objects for delete to authenticated using (bucket_id = 'taskfiles' and (owner_id = auth.uid()::text or public.is_management()));

-- ===== Trial data reset (CEO / GM, max 2 per month; see functions/admin-reset) =====
create table if not exists public.trial_resets (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  by_person text not null,
  counts jsonb
);
alter table public.trial_resets enable row level security;
revoke all on public.trial_resets from anon, authenticated;
create or replace function public.storage_object_names(b text)
returns setof text language sql security definer set search_path = '' as $$
  select name from storage.objects where bucket_id = b;
$$;
revoke all on function public.storage_object_names(text) from public, anon, authenticated;
grant execute on function public.storage_object_names(text) to service_role;
-- 'sys' records are written by the server only (e.g. the reset signal that makes open portals reload).
alter policy "staff add records" on public.records with check (is_staff() and collection <> 'sys');
alter policy "staff change records" on public.records using (is_staff() and collection <> 'sys') with check (is_staff() and collection <> 'sys');
alter policy "staff delete records" on public.records using (is_staff() and collection <> 'sys');

-- ===== Meeting register (Excel) kept on the server; see functions/meeting-register =====
insert into storage.buckets (id, name, public) values ('registers','registers', false) on conflict (id) do nothing;
-- Hourly refresh of the company-wide register (pg_cron):
-- select cron.schedule('meeting-register-refresh', '7 * * * *', $$ select net.http_post(
--   url := 'https://<project>.supabase.co/functions/v1/meeting-register',
--   headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from private.settings where key='cron_secret')),
--   body := '{"action":"refresh"}'::jsonb, timeout_milliseconds := 60000); $$);
-- Names and upload times of a bucket's files, for the "files-organize" server function (tidies old file names).
create or replace function public.storage_object_ages(b text)
returns table(name text, created_at timestamptz) language sql security definer set search_path = '' as $$
  select o.name, o.created_at from storage.objects o where o.bucket_id = b;
$$;
revoke all on function public.storage_object_ages(text) from public, anon, authenticated;
grant execute on function public.storage_object_ages(text) to service_role;
-- Easy look-up in Supabase (Table editor → Views): one row per attached file, with person, date, project and task.
create or replace view public.file_index with (security_invoker = true) as
  select (f->>'at')::timestamptz at time zone 'Asia/Dubai' as attached_at,
         to_char((f->>'at')::timestamptz at time zone 'Asia/Dubai', 'YYYY-MM-DD') as day,
         p.name as person, coalesce(pr.data->>'name', 'No project') as project, t.data->>'title' as task,
         case when f ? 'partIdx' then (t.data->'parts'->((f->>'partIdx')::int)->>'title') || case when f->>'stage'='done' then ' (on finishing)' else ' (at start)' end end as part,
         f->>'name' as file_name, round(coalesce((f->>'size')::numeric,0)/1048576, 2) as size_mb,
         u.name as uploaded_by, f->>'brief' as ai_brief, 'taskfiles' as bucket, f->>'path' as storage_path
  from public.records t
  cross join lateral jsonb_array_elements(coalesce(t.data->'files','[]'::jsonb)) f
  left join public.people p on p.id = t.data->>'owner'
  left join public.people u on u.id = f->>'by'
  left join public.records pr on pr.collection = 'projects' and pr.id = t.data->>'projectId'
  where t.collection = 'tasks';
revoke all on public.file_index from anon;
