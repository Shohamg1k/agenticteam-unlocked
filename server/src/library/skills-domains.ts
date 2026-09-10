import type { SkillDef } from '@agentic/core';

/**
 * Skills for the problems that keep producing the same bugs.
 *
 * The first library was organised by discipline — frontend, backend, quality.
 * These are organised by failure. Every entry exists because something shipped
 * broken in a way that had nothing to do with the language it was written in:
 * a tracker that forgot everything on refresh, a calendar that let a task be
 * "waiting" on a day that had passed, a login page that compared passwords as
 * strings.
 *
 * The same two rules as the original library apply, and they are what keep this
 * from turning into filler:
 *
 *  - **Nothing a competent model already does.** Every skill here says
 *    something specific enough to be wrong.
 *  - **`whenToUse` is load-bearing**, because the matcher ranks on it. It names
 *    the situation in the words a task would use.
 *
 * Scope matters as much as content. Nothing here is universal: with the four
 * universal skills already in every prompt, one more would cost every task in
 * the product tokens it cannot spend. Each of these declares the capabilities
 * and roles it is for, so it competes for a place rather than taking one.
 */

const skill = (
  name: string,
  description: string,
  whenToUse: string,
  appliesTo: SkillDef['appliesTo'],
  roles: SkillDef['roles'],
  body: string,
): SkillDef => ({
  name,
  description,
  whenToUse,
  appliesTo,
  roles,
  body: body.trim(),
  enabled: true,
  source: 'builtin',
});

export const DOMAIN_SKILLS: SkillDef[] = [
  // -------------------------------------------------------------------------
  // Frontend
  // -------------------------------------------------------------------------

  skill(
    'state-that-survives-a-reload',
    'If a person typed it, it is still there after a refresh',
    'Anything that holds what a user entered: a tracker, a list, a form, settings, a draft, a cart, a score',
    ['frontend', 'code'],
    ['frontend-engineer'],
    `A tracker that forgets everything when you refresh is not a tracker. It is a
demonstration of a tracker, and the difference is about five lines.

**Decide what must survive.** Anything a person typed or chose: their items,
their settings, an unfinished draft, the filter they set, where they were. Not
transient UI — a hover, a spinner, whether a menu is open right now.

**With no backend, that is \`localStorage\`**, and it is genuinely three lines:

\`\`\`js
const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; } };
\`\`\`

Both are wrapped, because storage throws in a private window and is full more
often than you would think. Failing to save must never take the page down with
it.

**Validate what comes back.** It was written by an older version of your code,
or by a user with a console open. Check the shape and drop what does not fit
rather than crashing on it — \`JSON.parse\` of corrupt data throws, and a
white screen on load is the worst possible failure.

**Save at the moment the state changes**, not on a timer and not on
\`beforeunload\`, which does not reliably fire on a phone.

**Namespace the key** — \`myapp.tasks\`, not \`tasks\` — because every app on
localhost shares one origin during development, and two projects will collide.

**Then actually test it.** Add something, reload the page, and look. This is the
single most common gap between "it works" and "it works", and it is found in
five seconds by the only test that matters.`,
  ),

  skill(
    'forms-that-help-you-finish',
    'Validation, errors and submission that do not fight the user',
    'Building a form, inputs, validation, a signup or checkout or settings screen',
    ['frontend'],
    ['frontend-engineer', 'ux-designer'],
    `Forms are where most software actually fails people, and every failure is a
decision somebody skipped.

**When to validate.** Not on every keystroke of a field they have not finished —
being told an email is invalid while typing the third character is hostile.
Validate on blur, and on submit. Once a field is marked wrong, revalidate as
they type so the error clears the instant it is fixed.

**What to say.** Name the field and the rule: "Password needs at least 8
characters" — not "Invalid input", and not a red border alone. The message sits
next to the field, is tied to it with \`aria-describedby\`, and survives long
enough to be read.

**Never lose their input.** A failed validation keeps every value. A failed
request keeps every value. This is the difference between an annoyance and
someone giving up.

**Submitting.** Disable the button while in flight and say what is happening,
so a double click cannot double submit. On success, say so — a form that just
clears itself looks like it lost the data. On failure, say what to do next.

**The details that make it usable:** a real \`<label for>\` on every input, the
right \`type\` and \`autocomplete\` so phones show the right keyboard and
password managers work, Enter submits, focus moves to the first error, and the
tab order matches the visual order.

**Trim whitespace before validating.** A trailing space in an email is not a
typo worth rejecting someone over.

And the rule that outranks all of this: **the browser validates for convenience,
the server validates for truth.** Anything that matters is checked again where
the data is written.`,
  ),

  skill(
    'motion-with-purpose',
    'Animation that explains a change instead of delaying one',
    'Adding animation, transitions, hover effects, loading states or anything that moves',
    ['frontend'],
    ['frontend-engineer', 'ux-designer'],
    `Motion earns its place by making a change comprehensible. Anything else is a
delay you are charging the user for, every single time.

**Duration.** 100-150ms for a hover or a small state change. 200-300ms for
something entering or leaving. Past 500ms it stops feeling responsive. The test
is the third viewing, not the first — what delights once irritates ten times.

**Easing.** Ease-out for arriving, ease-in for leaving, ease-in-out for moving
between two places. Linear for a spinner and almost nothing else.

**Animate \`transform\` and \`opacity\` only.** They are composited. Animating
\`width\`, \`height\`, \`top\`, \`left\` or \`margin\` forces layout on every
frame and stutters on the phone you did not test on.

**Always honour \`prefers-reduced-motion\`:**

\`\`\`css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
\`\`\`

For a real number of people this is not taste, it is vertigo. Reducing motion
must never remove the state change itself — a cross-fade instead of a slide,
never nothing at all.

**Interruptible.** A second click responds now rather than waiting for the first
animation to finish.

**Never move something the user is reading or about to click**, and never
animate on page load what could simply be there.`,
  ),

  // -------------------------------------------------------------------------
  // Correctness in specific domains
  // -------------------------------------------------------------------------

  skill(
    'dates-times-and-timezones',
    'Code about time that is still correct tomorrow',
    'Anything with a date, a calendar, a schedule, a deadline, a timestamp or a duration',
    ['code', 'frontend', 'strong-reasoning'],
    ['backend-engineer', 'frontend-engineer', 'architect'],
    `Nearly every date bug is the same bug: the code was written on a Tuesday and
is only right on that Tuesday.

**Derive anything that depends on now; never store it.** A task on a past date
is overdue — a function of the date and today, not a status field somebody has
to remember to update. Stored, it is wrong by morning. Derived, it cannot be.

This is exactly how a calendar tracker shipped that let a user mark a day in the
PAST as "waiting": the status was a field, so nothing stopped the combination
from existing.

**Compute "today" when you need it**, never at module load, never hard-coded.
An app left open across midnight must be right on the other side.

**Compare dates as dates.** \`YYYY-MM-DD\` strings compare correctly with \`<\`.
\`Date\` objects carry a time, so "today at 09:00" is after "today", and a naive
comparison marks today's items overdue. Normalise to the start of the day, or
compare day strings.

**Build calendars from real arithmetic.** \`new Date(y, m + 1, 0).getDate()\`
gives the length of a month; \`new Date(y, m, 1).getDay()\` gives its first
weekday. Never an offset that happens to work this month. February moves, and
a week does not start on Sunday everywhere.

**Ranges are validated where they are saved.** An end before its start is
impossible; refuse it, and name the field.

**Timezones, when they are in play:** store instants in UTC, convert only for
display, and never derive a calendar day by slicing a UTC ISO string — that
shifts the day for half the world. \`toISOString().slice(0,10)\` on a local date
is the single most common form of this bug.

**Recurrence is a rule, not rows.** Store "every Monday", generate occurrences
for the window in view, keep exceptions separately.

Test with a date that is not today: yesterday, the 1st, the 31st, the end of
February, and across a month boundary.`,
  ),

  skill(
    'auth-done-properly',
    'Sign-in that is a security control, not a screen that says welcome',
    'Building login, signup, sessions, passwords, tokens, permissions or protected routes',
    ['code', 'strong-reasoning'],
    ['backend-engineer', 'security-reviewer', 'architect'],
    `Authentication is the feature most often built as a demonstration of itself: a
form that compares a password to a string, a boolean called \`isLoggedIn\`, and
a route guard in the client. It works when you try it, and it protects nothing.

**Hash passwords with bcrypt, scrypt or argon2**, salted per password, with a
real work factor. Never a plain string comparison, never SHA-256, never MD5,
never something reversible. If the environment genuinely has no hashing library,
say so in your response rather than improvising one.

**Compare secrets in constant time** where you compare them yourself, and give
the same failure message whether or not the account exists — "no such user"
tells an attacker which addresses are registered.

**A session is server-side state or a signed token you verify on every
request.** A user id, a role or a user object arriving from the client is a
claim. Verify, never trust. Session cookies get \`httpOnly\`, \`secure\` and
\`sameSite\`; tokens get an expiry short enough to matter.

**Authorise where the data is, not where the link is.** Hiding a button is
decoration; the check that this user may read THIS record, by id, on every
request, is the control. Ownership checks are the most commonly missing thing in
an otherwise complete API.

**Rate-limit sign-in.** Without it, a password is only as good as how fast
somebody can try every one.

**Secrets come from configuration.** A signing key in source has been published.
Read it from the environment, fail loudly at startup when it is missing, and say
in your response what must be set.

**Never log a password, a token or a session id** — not at debug level, not in
an error, not "temporarily".

If the task is explicitly a mockup, build the screens properly and say in one
line that nothing is actually authenticated, so nobody deploys it thinking
otherwise.`,
  ),

  skill(
    'talking-to-someone-elses-api',
    'Calling a service you do not control, without inheriting its bad days',
    'Calling a third-party API, an external service, a webhook, an SDK or any remote HTTP endpoint',
    ['code'],
    ['backend-engineer', 'devops'],
    `Code that calls a service you do not own has a dependency that will be slow,
rate-limited and occasionally wrong. Write for that, not for the demo.

**Every request has a timeout.** No exceptions. A call with no timeout is how
one slow vendor takes a whole application down, and it is always the thing
nobody thought needed one.

**Retry only what retrying can fix.** Network errors, 429 and 5xx, with
exponential backoff and jitter. A 400 or 403 fails identically forever; retrying
it just burns quota. Honour \`Retry-After\`.

**Retries need idempotency.** A retried charge is a second charge. Send an
idempotency key where the API supports one; where it does not, make a duplicate
detectable on your side before risking the second call.

**Validate the response before it reaches your domain.** Assume the field can be
missing, null, or a different type than yesterday. A clear failure at the
boundary beats an exception four layers in.

**Translate their errors into yours.** A vendor's raw error surfacing in your UI
is a leak of your architecture and of their internals; catch it and say
something your user can act on.

**Never let a partial failure look like success.** If three of five calls
worked, the result says so.

**Credentials from configuration, never in source, never in a log line.**

**Webhooks are hostile input**: verify the signature before parsing, respond
immediately and process asynchronously, and expect every event at least twice —
dedupe by id.

Log the endpoint, the duration and the status of each call. At 3am that log is
the entire investigation.`,
  ),

  skill(
    'input-validation-at-the-edge',
    'Refusing impossible values where they are written, not where they are typed',
    'Accepting anything from a person or another system: a form, a request body, a query parameter, an upload, a config file',
    ['code', 'frontend', 'strong-reasoning'],
    ['backend-engineer', 'frontend-engineer', 'security-reviewer'],
    `A rule enforced only in the UI is not enforced. Somebody will reach the write
by keyboard, by paste, by a stale tab, by curl, or by a reload that replays the
last request.

**Validate where the value is stored, and hint in the input.** The date picker
that hides past dates is a courtesy; the save that refuses one is the guarantee.
Both, always — the hint means they find out early, the check means it cannot be
wrong.

**Decide what each of these does before a user finds out:** empty, whitespace
only, absurdly long, a duplicate, zero, negative, a decimal where an integer
belongs, a word where a number belongs, a date that does not exist, a value from
a dropdown that is no longer in the dropdown.

**Reject with a message that names the field and the rule.** "Invalid input"
tells a person nothing about what to do next. "Quantity must be at least 1" does.

**Whitelist, do not blacklist.** Say what is allowed rather than trying to
enumerate what is not. Every blacklist has a hole, and it is always found.

**Coerce deliberately, at the boundary, once.** A number arriving as a string
becomes a number where it enters the system, and everything inside can then
assume its type. Scattered \`parseInt\` calls are how \`"12" + 1 === "121"\`
reaches production.

**Bound everything unbounded.** A string with no maximum length, a list with no
maximum size and a page with no maximum limit are all denial-of-service waiting
to be discovered.

**Never build SQL, a shell command, a file path or HTML by concatenation.**
Parameterise, escape, or resolve and check the path is inside the directory you
meant.`,
  ),

  // -------------------------------------------------------------------------
  // Operating what you built
  // -------------------------------------------------------------------------

  skill(
    'logging-worth-having',
    'Logs that answer the question you will have at 3am',
    'Adding logging, debugging a production problem, or writing a service that has to be operated',
    ['code'],
    ['backend-engineer', 'devops'],
    `Logs are written once and read under pressure, months later, by someone who
does not remember the code. Write for that reader.

**Log the boundaries and the decisions**: a request in with its outcome and
duration, an external call with its status, a job starting and finishing, a
branch that was taken for a non-obvious reason. Not every line of a function.

**Include what identifies the case.** A message that says "failed to update
user" cannot be investigated. One that carries the user id, the operation and
the reason can be. Structure the fields rather than baking them into a sentence,
so they can be searched.

**Levels mean things.** \`error\` is something a person must act on. \`warn\` is
something that will become an error. \`info\` is the shape of normal operation.
\`debug\` is for development. An application that logs everything at \`error\`
has no errors, because nobody looks any more.

**Never log a secret.** No passwords, tokens, keys, session ids, card numbers or
full request bodies that might contain them. Redact at the point of logging, not
by remembering not to pass them.

**Log the error, not just that there was one.** The message, the type, and the
stack. \`catch (e) { log('failed') }\` throws away the only thing that would
have explained it.

**Do not log in a tight loop**, and never let a logging failure take down the
operation it was describing.

The test: could someone who has never seen this code work out what happened,
from the logs alone? If not, they are decoration.`,
  ),

  skill(
    'configuration-and-secrets',
    'Settings and credentials that differ per environment and never ship in source',
    'Adding a setting, an API key, a database URL, an environment variable or anything that differs between dev and production',
    ['code'],
    ['backend-engineer', 'devops', 'architect'],
    `Anything that differs between your machine and production is configuration.
Anything that would be damaging in a stranger's hands is a secret. Neither
belongs in the source.

**Read configuration from the environment**, with one module that reads it,
validates it, and exposes typed values. Scattered \`process.env.THING\` reads
are how a typo becomes \`undefined\` and a service silently talks to the wrong
database.

**Fail at startup, not at first use.** A missing required variable should stop
the process immediately with a message naming it — not throw at 2am the first
time somebody uses the feature that needed it.

**Defaults are for the harmless.** A port or a log level can default. A secret,
a database URL or a production endpoint must not — a default here is a
misconfiguration that works well enough to hide.

**Commit \`.env.example\`, never \`.env\`.** The example lists every variable
with a comment on what it is for and whether it is required, and no real values.
Check that \`.env\` is in \`.gitignore\`.

**Never log a secret, never put one in an error message, and never send one to
the client.** In a browser app, remember that every bundled variable is public
however it is named — an API key that must stay secret cannot live in frontend
code at all, and the answer is a server-side proxy.

**Say what needs setting.** When you add a variable, your response names it, its
purpose and its default — otherwise the next person finds out from a crash.`,
  ),

  skill(
    'dependencies-worth-their-weight',
    'Deciding what to install, and what to just write',
    'Adding a package or a library, or choosing between doing it yourself and installing something',
    ['code'],
    ['backend-engineer', 'frontend-engineer', 'architect', 'devops'],
    `Every dependency is a permanent cost: install time, bundle size, a security
surface, and a thing that will eventually break on an upgrade you did not want
to do.

**Do not add one for something small and stable.** Left-pad, a debounce, a
clamp, a slug, a unique-by-key — these are three to ten lines you will never
have to upgrade. Write them.

**Do add one for something you would get wrong.** Cryptography, password
hashing, date arithmetic across timezones, parsers, protocol clients. "I could
write this" is usually true and usually the wrong instinct; the library has
handled cases you have not thought of, and in the case of crypto, your version
is a vulnerability.

**Before adding, check** that it is maintained, that its licence is compatible,
that it does not pull in fifty transitive packages for the one function you
want, and that it is not already in the project under another name — most
codebases have two date libraries and two HTTP clients.

**Prefer what the platform now does.** \`fetch\`, \`structuredClone\`,
\`Intl\`, \`crypto.randomUUID\`, CSS grid and \`:has()\` have all removed the
reason for a dependency people still install out of habit.

**Pin versions.** An unpinned toolchain is a future outage that arrives on
somebody else's schedule.

When you do add one, say in your response what it is for and why the
alternative was worse. A dependency nobody can justify is one nobody dares
remove.`,
  ),

  skill(
    'naming-that-explains',
    'Names that make the comment unnecessary',
    'Writing any code — naming variables, functions, files, endpoints, database columns or CSS classes',
    ['code', 'frontend'],
    [],
    `A name is read far more often than it is written, and it is the cheapest
documentation there is.

**Say what it is, not what type it is.** \`users\` not \`userArray\`,
\`isVisible\` not \`visibleFlag\`. The type system already knows the type.

**Booleans read as a question with a yes answer:** \`isOpen\`, \`hasAccess\`,
\`canEdit\`, \`shouldRetry\`. Never a negative — \`isNotReady\` guarantees that
somebody will write \`!isNotReady\`.

**Functions are verbs, and the verb is honest about the cost.** \`getUser\`
returns something you have; \`fetchUser\` goes over the network; \`loadUser\`
might do either and says so. A \`get\` that makes a request will be called in a
loop by someone who trusted the name.

**Say the units.** \`timeoutMs\`, \`sizeBytes\`, \`priceCents\`, \`delaySeconds\`.
Almost every unit bug is a name that omitted the unit.

**One concept, one word, everywhere.** If it is a \`user\` in the database it is
not a \`member\` in the service and an \`account\` in the UI. Pick one and hold
it across the whole stack.

**Length matches scope.** \`i\` is fine in a three-line loop. A module-level
export needs a name that stands alone with no context at all.

**Do not abbreviate what is not universally abbreviated.** \`id\`, \`url\`,
\`http\` are fine. \`usrMgr\`, \`calcTot\`, \`hndlReq\` are a puzzle for
everyone who comes after.

If a name needs a comment to explain what it holds, the name is wrong. Rename
it and delete the comment.`,
  ),
];
