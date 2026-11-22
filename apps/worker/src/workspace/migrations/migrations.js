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
import m0009 from './0009_target_status_index.sql';
import m0010 from './0010_may_have_sent.sql';
import m0011 from './0011_own_text.sql';
import m0012 from './0012_notifications.sql';
import m0013 from './0013_scheduling.sql';
import m0014 from './0014_post_created_at_index.sql';

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
m0008,
m0009,
m0010,
m0011,
m0012,
m0013,
m0014
    }
  }
  