-- The foundation's devnet host took its own name: https://host.devnet.forest.foundation, in place of
-- the Railway address it had since it was the test board. It is the same host, with the same log
-- and the same numbers, so what this index read under the old address is moved to the new one: the
-- cursor (it resumes where it was, reading nothing twice), every record read and which pictures it
-- holds. For an index that never read that address, this changes nothing.

update cursors set source = 'host:https://host.devnet.forest.foundation'
  where source = 'host:https://board-devnet-test-production.up.railway.app';
update host_records set host = 'https://host.devnet.forest.foundation'
  where host = 'https://board-devnet-test-production.up.railway.app';
update blobs set host = 'https://host.devnet.forest.foundation'
  where host = 'https://board-devnet-test-production.up.railway.app';
