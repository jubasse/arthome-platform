// The wire types, re-exported by context.
//
// ⚠ EVERYTHING BELOW `gen/` IS GENERATED — `pnpm run gen:events`. Editing a file
//   there is lost at the next generation, and the source of truth is
//   arthome-core's proto/, which `buf breaking` protects.
//
// Only the contexts a service in this repository actually speaks are re-exported
// here. A barrel over all eight would make every service carry the wire types of
// the seven others, and would hide which context a service really depends on.

export * from './gen/arthome/common/v1/common_pb.js';
export * from './gen/arthome/identity/v1/events_pb.js';
