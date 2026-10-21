-- خِدمة — PDF attachments for assignments (run ONCE in Supabase → SQL Editor)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assignment-files', 'assignment-files', true, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = true, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];

drop policy if exists "assignment files read"   on storage.objects;
drop policy if exists "assignment files upload" on storage.objects;
drop policy if exists "assignment files delete" on storage.objects;

create policy "assignment files read"   on storage.objects for select using (bucket_id = 'assignment-files');
create policy "assignment files upload" on storage.objects for insert with check (bucket_id = 'assignment-files');
create policy "assignment files delete" on storage.objects for delete using (bucket_id = 'assignment-files');
