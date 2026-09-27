// Apart from the index, so a service that runs no Nest (notifications, search-indexer, the tools)
//   loads none of it through this package.
export { ConsumerHost, ConsumerHostModule } from './consumer-host.module.js';
export type { ConsumerHostOptions } from './consumer-host.module.js';
