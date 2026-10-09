-- SideQuest v1 schema
-- Tables: profiles, groups, members, quests, quest_participants, entries
-- Security: every table has RLS. You only see data from groups you belong to.

-- ---------- tables ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Adventurer' check (char_length(display_name) between 1 and 40),
  avatar_seed text not null,
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index members_user_idx on public.members(user_id);

create table public.quests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  details text check (char_length(details) <= 2000),
  location text check (char_length(location) <= 120),
  due_date date,
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index quests_group_idx on public.quests(group_id);
create index quests_created_by_idx on public.quests(created_by);

create table public.quest_participants (
  quest_id uuid not null references public.quests(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (quest_id, user_id)
);
create index quest_participants_user_idx on public.quest_participants(user_id);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  quest_id uuid not null references public.quests(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  note text check (char_length(note) <= 4000),
  photo_paths text[] not null default '{}',
  done_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index entries_group_idx on public.entries(group_id);
create index entries_quest_idx on public.entries(quest_id);
create index entries_author_idx on public.entries(author_id);

-- ---------- helper functions (security definer so RLS policies don't recurse) ----------
create function public.is_member(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members
    where group_id = gid and user_id = (select auth.uid())
  )
$$;

create function public.shares_group_with(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.members a
    join public.members b on a.group_id = b.group_id
    where a.user_id = (select auth.uid()) and b.user_id = uid
  )
$$;

create function public.quest_in_my_group(qid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.quests q
    join public.members m on m.group_id = q.group_id
    where q.id = qid and m.user_id = (select auth.uid())
  )
$$;

-- ---------- RPCs the app calls ----------
create function public.create_group(group_name text) returns public.groups
language plpgsql security definer set search_path = '' as $$
declare g public.groups;
begin
  if (select auth.uid()) is null then raise exception 'Not signed in'; end if;
  insert into public.groups (name, created_by)
  values (trim(group_name), (select auth.uid()))
  returning * into g;
  insert into public.members (group_id, user_id, role)
  values (g.id, (select auth.uid()), 'admin');
  return g;
end $$;

create function public.join_group(code text) returns public.groups
language plpgsql security definer set search_path = '' as $$
declare g public.groups;
begin
  if (select auth.uid()) is null then raise exception 'Not signed in'; end if;
  select * into g from public.groups where invite_code = upper(trim(code));
  if not found then raise exception 'That invite code does not exist'; end if;
  insert into public.members (group_id, user_id)
  values (g.id, (select auth.uid()))
  on conflict do nothing;
  return g;
end $$;

-- auto-create a profile whenever someone signs up
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, avatar_seed)
  values (
    new.id,
    coalesce(nullif(left(split_part(new.email, '@', 1), 40), ''), 'Adventurer'),
    new.id::text
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- lock down who can call what
revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.shares_group_with(uuid) from public, anon;
revoke execute on function public.quest_in_my_group(uuid) from public, anon;
revoke execute on function public.create_group(text) from public, anon;
revoke execute on function public.join_group(text) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.shares_group_with(uuid) to authenticated;
grant execute on function public.quest_in_my_group(uuid) to authenticated;
grant execute on function public.create_group(text) to authenticated;
grant execute on function public.join_group(text) to authenticated;

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.quests enable row level security;
alter table public.quest_participants enable row level security;
alter table public.entries enable row level security;

-- profiles: see yourself + people who share a group with you
create policy "profiles_select" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_group_with(id));
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- groups: members only (creating/joining goes through the RPCs above)
create policy "groups_select" on public.groups for select to authenticated
  using (public.is_member(id));

-- members: see your group's roster, and you can leave
create policy "members_select" on public.members for select to authenticated
  using (public.is_member(group_id));
create policy "members_leave" on public.members for delete to authenticated
  using (user_id = (select auth.uid()));

-- quests: any member can add/edit, only the creator can delete
create policy "quests_select" on public.quests for select to authenticated
  using (public.is_member(group_id));
create policy "quests_insert" on public.quests for insert to authenticated
  with check (public.is_member(group_id) and created_by = (select auth.uid()));
create policy "quests_update" on public.quests for update to authenticated
  using (public.is_member(group_id)) with check (public.is_member(group_id));
create policy "quests_delete" on public.quests for delete to authenticated
  using (created_by = (select auth.uid()));

-- who's in on each quest
create policy "participants_select" on public.quest_participants for select to authenticated
  using (public.quest_in_my_group(quest_id));
create policy "participants_insert" on public.quest_participants for insert to authenticated
  with check (public.quest_in_my_group(quest_id));
create policy "participants_delete" on public.quest_participants for delete to authenticated
  using (public.quest_in_my_group(quest_id));

-- diary entries: members read, author writes
create policy "entries_select" on public.entries for select to authenticated
  using (public.is_member(group_id));
create policy "entries_insert" on public.entries for insert to authenticated
  with check (public.is_member(group_id) and author_id = (select auth.uid()));
create policy "entries_update" on public.entries for update to authenticated
  using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "entries_delete" on public.entries for delete to authenticated
  using (author_id = (select auth.uid()));

-- ---------- photo storage (private bucket; path = <group_id>/<quest_id>/<file>.jpg) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "photos_select" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "photos_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
create policy "photos_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));

-- ---------- realtime (live updates when a friend adds or checks off a quest) ----------
alter publication supabase_realtime add table public.quests, public.entries, public.quest_participants;
