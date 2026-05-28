// Thin entry for local debugging — production uses railwayBootstrap.js.

import 'dotenv/config';
import { logDatabaseUrlReady, resolveDatabaseUrl } from '../shared/resolveDatabaseUrl.js';

const label = process.env.RAILWAY_SERVICE_NAME ?? 'ssa';

try {
  const url = resolveDatabaseUrl(label);
  logDatabaseUrlReady(url, label);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  throw err;
}
