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

## Comments — delete by default

**The default is no comment.** Name it first: `waitUntilDue` needs no gloss, `handleRetryTiming`
needs one. Then comment only what a name cannot carry.

**The test**: would a reader with this code in front of them learn something they could not derive
from it?

**Keep** — a measured failure with what it cost · a constraint invisible at that line · a decision
and its reason · a `⚠` where the obvious change is wrong.

**Delete** — a comment on trivial code (a delegate, a getter, a `findAll` calling `Model.findAll`) ·
a block above a name that already carries it · JSDoc restating the signature · narration of a
readable sequence · history · a default explained · prose about what the file does *not* do.

**Where one line does, use one line.** A surviving `⚠` is two to four lines, never ten.

⚠ **Never delete a recorded measurement** — shorten its prose to one sentence, keep the fact. And
**never a one-line gloss on an exported name**: `REPOSITORY_MAP.md` is generated from it.

⚠ **The mechanism that produces the problem**: paying yourself in comment lines for what the
discovery cost. That belongs in the commit message, not at the line.

Full rule, with four measured shapes: `code-conventions.md` §5.10.
