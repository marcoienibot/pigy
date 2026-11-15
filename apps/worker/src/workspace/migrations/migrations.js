import journal from './meta/_journal.json';
import m0000 from './0000_posts.sql';
import m0001 from './0001_rejections.sql';
import m0002 from './0002_channels.sql';
import m0003 from './0003_server_time.sql';
import m0004 from './0004_limits.sql';
import m0005 from './0005_targets.sql';
import m0006 from './0006_keyed_calls.sql';
import m0007 from './0007_deliveries.sql';
import m0008 from './0008_delivery_started_at.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008
    }
  }
  