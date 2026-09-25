// The wire types, re-exported by context.
//
// ⚠ EVERYTHING BELOW `gen/` IS GENERATED — `pnpm run gen:events`. Editing a file
//   there is lost at the next generation, and the source of truth is
//   arthome-core's proto/, which `buf breaking` protects.
//
// Only the contexts a service in this repository actually speaks are re-exported
// here. A barrel over all eight would make every service carry the wire types of
// the seven others, and would hide which context a service really depends on.

// ⚠ THIS FLAT BARREL IS ON BORROWED TIME, and it is worth saying before it bites.
//   Three contexts share no exported symbol today — verified, 14 + 31 + 34 names
//   with an empty intersection — but `export *` from several generated files is
//   exactly the shape that breaks on the day two contexts name the same message.
//   The durable answer is the one @arthome/contracts already applies to itself:
//   no `.` entry point at all, one subpath per context, so a service declares
//   which contexts it speaks. Owed before the fourth context lands here.
export * from './gen/arthome/common/v1/common_pb.js';
export * from './gen/arthome/identity/v1/events_pb.js';
export * from './gen/arthome/catalog/v1/events_pb.js';
