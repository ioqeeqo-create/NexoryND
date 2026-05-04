-- Flow social schema (run in Supabase SQL Editor)

create table if not exists public.flow_profiles (
  username text primary key,
  password_hash text,
  password_salt text,
  online boolean not null default false,
  last_seen timestamptz not null default now(),
  avatar_data text,
  banner_data text,
  profile_color text,
  bio text not null default '',
  pinned_tracks jsonb not null default '[]'::jsonb,
  pinned_playlists jsonb not null default '[]'::jsonb,
  total_tracks integer not null default 0,
  total_seconds bigint not null default 0
);

alter table public.flow_profiles add column if not exists avatar_data text;
alter table public.flow_profiles add column if not exists banner_data text;
alter table public.flow_profiles add column if not exists profile_color text;
alter table public.flow_profiles add column if not exists password_hash text;
alter table public.flow_profiles add column if not exists password_salt text;
alter table public.flow_profiles add column if not exists bio text not null default '';
alter table public.flow_profiles add column if not exists pinned_tracks jsonb not null default '[]'::jsonb;
alter table public.flow_profiles add column if not exists pinned_playlists jsonb not null default '[]'::jsonb;
alter table public.flow_profiles add column if not exists total_tracks integer not null default 0;
alter table public.flow_profiles add column if not exists total_seconds bigint not null default 0;

create table if not exists public.flow_friends (
  owner_username text not null,
  friend_username text not null,
  created_at timestamptz not null default now(),
  primary key (owner_username, friend_username)
);

create table if not exists public.flow_friend_requests (
  from_username text not null,
  to_username text not null,
  status text not null default 'pending',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (from_username, to_username)
);

create table if not exists public.flow_rooms (
  room_id text primary key,
  host_peer_id text not null,
  shared_queue jsonb not null default '[]'::jsonb,
  now_playing jsonb,
  playback_state jsonb not null default '{}'::jsonb,
  playback_ts bigint not null default 0,
  updated_by_peer_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.flow_room_members (
  room_id text not null,
  peer_id text not null,
  username text not null,
  profile jsonb not null default '{}'::jsonb,
  last_seen timestamptz not null default now(),
  primary key (room_id, peer_id)
);

create index if not exists idx_flow_friends_owner on public.flow_friends(owner_username);
create index if not exists idx_flow_friends_friend on public.flow_friends(friend_username);
create index if not exists idx_flow_friend_requests_to on public.flow_friend_requests(to_username, status, updated_at desc);
create index if not exists idx_flow_room_members_room_seen on public.flow_room_members(room_id, last_seen desc);
create index if not exists idx_flow_rooms_updated_at on public.flow_rooms(updated_at desc);

alter table public.flow_profiles enable row level security;
alter table public.flow_friends enable row level security;
alter table public.flow_friend_requests enable row level security;
alter table public.flow_rooms enable row level security;
alter table public.flow_room_members enable row level security;

-- Public app mode (no auth yet): allow anon read/write.
-- You can tighten these later after moving to Supabase Auth.
drop policy if exists "flow_profiles_public_rw" on public.flow_profiles;
create policy "flow_profiles_public_rw" on public.flow_profiles
for all to anon
using (true)
with check (true);

drop policy if exists "flow_friends_public_rw" on public.flow_friends;
create policy "flow_friends_public_rw" on public.flow_friends
for all to anon
using (true)
with check (true);

drop policy if exists "flow_friend_requests_public_rw" on public.flow_friend_requests;
create policy "flow_friend_requests_public_rw" on public.flow_friend_requests
for all to anon
using (true)
with check (true);

drop policy if exists "flow_rooms_public_rw" on public.flow_rooms;
create policy "flow_rooms_public_rw" on public.flow_rooms
for all to anon
using (true)
with check (true);

drop policy if exists "flow_room_members_public_rw" on public.flow_room_members;
create policy "flow_room_members_public_rw" on public.flow_room_members
for all to anon
using (true)
with check (true);
