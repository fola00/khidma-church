-- ============================================================
-- خِدمة — SECURITY STEP 2 of 2: LOCK THE DATABASE
-- Run this ONLY AFTER:  (1) step 1 ran,  (2) the new app files are uploaded,
-- (3) you tested a login and the Director login on the live site.
-- After this, nobody can read, list, change or delete the data directly — only through
-- the secure functions. OLD copies of the app (v7 and earlier) will stop working.
-- ============================================================

drop policy if exists "allow all" on app_state;
revoke all on app_state from anon, authenticated;
alter table app_state enable row level security;

-- uploaded PDFs: keep public reading + uploading, but nobody can delete files with the public key
drop policy if exists "assignment files delete" on storage.objects;

notify pgrst, 'reload schema';

-- To UNDO (if something goes wrong), run:
--   create policy "allow all" on app_state for all using (true) with check (true);
--   grant select, insert, update, delete on app_state to anon, authenticated;
