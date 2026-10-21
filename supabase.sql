-- Виконати один раз у Supabase: SQL Editor → New query → вставити → Run

create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  date date not null,
  weight numeric,
  price numeric not null default 0,
  kcal numeric,
  protein numeric,
  fat numeric,
  carbs numeric,
  photo text,
  created_at timestamptz not null default now()
);

-- Кожен бачить і змінює тільки свої покупки
alter table public.items enable row level security;
create policy "own items" on public.items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Фото продуктів: файли з випадковими назвами, заливати можна тільки у свою папку
insert into storage.buckets (id, name, public) values ('photos', 'photos', true);
create policy "upload own photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
