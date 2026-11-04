import { createGetDb } from '@agent-native/core/db';
import { registerShareableResource } from '@agent-native/core/sharing';

import * as schema from './schema.js';

export const getDb = createGetDb(schema);
export { schema };

registerShareableResource({
  type: 'service-graph',
  resourceTable: schema.serviceGraphs,
  sharesTable: schema.serviceGraphShares,
  displayName: 'Service graph',
  titleColumn: 'name',
  getResourcePath: (graph) => `/bench/${graph.id}`,
  getDb,
});
