# arthome-platform

## Load the NestJS router before writing NestJS code — every session, without exception

**`nestjs-how-to`.** Load it at the start of any task that writes, reviews or debugs code in this
repository, and load the skills it routes to. This includes the first task after a context
compaction: a compacted session keeps the conclusions and loses the reflex.

**Follow those skills to the letter.** They are the project's chosen best practices, not
suggestions, and they are more current than any model's memory of NestJS — v12 changed ESM,
Express 5, validation and the error model. Where a skill and a recollection disagree, the skill is
right.

The routed list for this repository, with the dependency that pulls each one in, is in
[`AGENTS.md`](AGENTS.md) under **Required NestJS skills**. It is written once, there: `nestjs-how-to`
re-derives it from `package.json` anyway, so a second copy here could only drift.

⚠ **THIS FILE EXISTS BECAUSE THE SKILLS WERE NOT LOADED.** `identity`, `notifications` and `catalog`
were written without them. `nestjs-event-driven` was opened late and immediately corrected two real
defects already in the code — no jitter on retries, and no guard against a retry topic reordering one
aggregate's events — and `nestjs-validation` was never opened at all, which is why two controllers
accepted any JSON body. Skills trigger on their descriptions, and an agent that believes it already
knows NestJS skips them.

## Read AGENTS.md

**[`AGENTS.md`](AGENTS.md) is this repository's working guide, and it is not loaded for you — read it
at the start of a session.** Whether a tool picks it up by itself varies, so the instruction is here
rather than assumed. It holds the three documents to read first, the commands, how to run the event
path, and what happens when a message cannot be applied.

## Comments — the why and the failure, never the what

**Name it, then comment what the name cannot carry.** A function named for exactly what it does and a
variable named for exactly what it holds remove the paragraph above them — and a long name is the
cheap side of that trade. `waitUntilDue` needs no gloss; `handleRetryTiming` needs one.

**JSDoc is not owed to every export.** Write it when the code is non-trivial, or when the reader needs
context the signature cannot give. A one-line function whose name says what it does gets nothing, and
a `@param` restating the parameter's name is noise. When a comment is warranted, it is **concise**.

A comment earns its place by saying something the code cannot. The test: *would a reader with this
code in front of them learn something they could not derive from it?*

**Keep** a measured failure, a constraint that is not visible locally, a decision and its reason, and
a `⚠` on a trap where the obvious change is the wrong one. **Cut** anything that restates the code,
explains a well-named function, narrates a readable sequence, or copies what `DECISIONS.md` already
says — link instead.

Past roughly a quarter of a file, ask whether the code is unclear rather than under-explained.
Measured on 2026-09-25, three files in arthome-platform's `libs/messaging` stood at 59 %, 55 % and
40 %.

⚠ **This is not a licence to delete reasons.** Where a comment is long *because* it records something
expensive, shorten the prose and keep the fact. Never delete a recorded reason to satisfy a ratio.

**Apply it opportunistically**: any file you read or modify is one you may shrink. It costs a moment
while the context is already loaded, and it is the only way this reaches code written before it.

⚠ **THE FAILURE MODE THAT CAUSES ALL OF THIS: PAYING YOURSELF IN COMMENT LINES FOR WHAT THE DISCOVERY
COST.** A line you just fought for feels load-bearing, so it gets a paragraph defending it — and a
twelve-line configuration object ends up under forty lines of prose. **The effort of finding something
out is not the reader's problem.** The commit message is where it belongs, at any length; the code
carries only what will bite the next person at that line.

Three shapes give it away: a **default written out with a paragraph defending it** (delete both — a
default nobody overrides is not a decision); a **comment on a self-documenting option** (`applicationName`
did not need four lines saying what `applicationName` is for); and a **comment explaining an absence**,
which is the worst because nothing fails when it stops being true — prose about what a file does *not*
do belongs beside the thing that *is* done.

The full rule is `code-conventions.md` §5.10 — in `docs/arthome/` here, and the original in
arthome-core.
