-- After 013 moved what this index read to the host's new name, the index it replaced ran a few
-- seconds more, as a deploy on Railway overlaps the old and the new: it found no cursor under the
-- old address, read the whole host again from the start under it, and checked a picture there.
-- Everything under the old address is a copy of what is under the new one, so it goes. The index
-- reads only the new name now, so nothing writes the old one again. For an index that never read
-- that address, this changes nothing.

delete from cursors where source = 'host:https://board-devnet-test-production.up.railway.app';
delete from host_records where host = 'https://board-devnet-test-production.up.railway.app';
delete from blobs where host = 'https://board-devnet-test-production.up.railway.app';
