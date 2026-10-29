# e2e

Part of Forest's services: [the top README](../README.md).

The loop: Forest end to end, two people doing what a person does, each with their app (on a device
of their own, holding their seed) and an AI acting for them, with every service this repo runs.

It is not a service. CI runs it on every pull request, and anyone can; the main way is
`npm run e2e`, with no chain and no secret. CI's log of each run is its record.

## How it works

### Who is who

- **Each person's device** is the reference app, [`mcp/test/app.ts`](../mcp/test/app.ts),
  unchanged. It holds the seed and the person's stamp (the verifier's signature that it checked the
  person), keeps the person's Profiles folder (the folder, locked to a key only the seed gives, that
  lists their profiles and stamps), makes each profile with a verification (the proof, made on the
  device, that its seed holds a stamp), signs with each profile's main key, writes straight to the
  host, and, at the connect page, hands the mcp an access key for the profile ticked. What it has no
  method for, the device does in `e2e.ts`, with the standard's pieces:
  - the stamp, asked of the verifier with its welcome gift, which the device hands its app to keep;
  - the gift's credits, collected at the host with the gift's ticket;
  - the reputation proof, made on the device.
- **Each person's AI** is the MCP SDK's own client, through mcp's own test helpers (`aiApp`,
  `logIn`, in [`mcp/test/setup.ts`](../mcp/test/setup.ts)). It logs in as an AI app does, and calls
  the mcp's tools as a chat calls them, over MCP (the Model Context Protocol, the way AI apps call
  outside tools). It holds no key and is told no address of its own person's.
- **The connect page** is the loop's stand-in for the Forest app's, in `e2e.ts`: the person whose
  turn it is ticks the profile their AI acts in, and their app hands back the pack.

### What one run does

Two people, a tutor who sells and a student who buys, each from a seed of their own, in the market
`tutoring`. Every step checks what it did, and the run passes only if every step does.

1. **Keys.** From each seed:
   - the profile `tutoring/tutor` or `tutoring/student`: its address, and its pay addresses,
     `{ solana, evm }`;
   - the stamp number at the loop verifier's name.

   From the tutor's seed, a second profile too: `sports-coaching/coach`.
2. **Stamps.** Each person takes the loop verifier's face check: its stand-in Didit passes everyone.
   The app first reads the verifier's welcome gift in its `GET /` (10 of the loop host's credits,
   prepaid units of its writes, and the sponsor key that signs for them), makes one buy at the host
   of exactly those credits with the host's credits client (`host/client/`), and asks the stamp with
   the buy's reference. Each gets a stamp for their stamp number, checked:
   - its signature;
   - the face key;
   - the stamp number;

   and the gift's ticket, signed by the verifier's sponsor key. The device keeps the stamp. Then it
   asks the verifier for it again by its stamp number (`POST /stamp`), as a device that lost it
   would, and the stamp that comes back is the one signed.
3. **Credits.** Each app collects its buy at the host with the gift's ticket
   (`Forest-Payment: ticket <ticket>`), the host taking the tickets of the loop verifier's sponsor,
   and finishes its 10 credits.
4. **Profiles.** Each person's device spends 2 credits into their Profiles folder, where the app
   keeps the stamp, then the rest into the profile's folder (the tutor keeps 3 for the coach
   profile), and the app adds the profile and lists it in the Profiles folder. Read back from the
   host as any reader reads it, the profile entry holds the market, the role and the profile's open
   key, so it takes messages, and the run checks:
   - its pay addresses, `pay { solana, evm }`, each signed by its pay key;
   - its verification, made on the device from the stamp it keeps and the verification circuit's
     committed proving files, which checks.
5. **Logins.** Each AI's first call to act gets the mcp's challenge. The person's browser goes
   through the connect page, where they tick their tutoring profile, and their app makes an access
   key, lists it in the profile entry with all four switches (`read-inbox`, `read`, `write`,
   `message`), writes its note, and hands the mcp the pack; the AI gets its login, and
   `my_profiles` shows that profile, by its label, with those switches. Read back from the host:
   - the profile entry lists that one access key;
   - its note, at its keyed path, is locked to one key, and opens for the main key, naming this mcp.
6. **mcp.** Every call goes through the AI's own client:
   - the tutor's AI reads the market (`markets`, `tutoring`), then writes an offer (`write`, at
     `offer/maths`): maths, 2 USD an hour, paid `direct`. On the host it is current, signed by the
     tutor's access key;
   - the student's AI finds it with `search`, the loop index's search through the mcp, and messages
     the tutor at the post's profile (`message`);
   - the tutor's AI reads its inbox (`read`, `inbox`): the message, from the student's address,
     counted (the student's profile entry lists the key that signed it with `message`), with the
     student's market, role and face check as the index shows them; and replies to the address it
     came from (`message`);
   - the student's AI reads the reply in its own inbox.
7. **The review.** The student's AI writes one (`write`, at `review/maths`): it scores the tutor 10
   and names the offer. On the host it is signed by the student's access key.
8. **The index.** The loop's index shows:
   - both profiles counted under the loop verifier's face key;
   - the offer listed;
   - the review counted;
   - what each profile shows as the index's own ranking makes it from this one review, a rating
     and its writer's word about the tutor, a vouch, with the index's numbers in
     `index/config/scoring.json`. The loop works them out with the same code: today the tutor rated
     10.0 by one rater, trust 44, the student no rating, trust 38, each uniqueness 75. Each statement
     is signed by the index and checked.

   No message appears anywhere in its JSON.
9. **The trust, carried.** The tutor's device finds its own leaf among the index's leaves by its
   profile, with its trust. It checks the root the index signed, and proves its tutoring trust on
   the device onto its coach profile (the standard's reputation circuit), naming none of its
   profiles. The app adds the coach profile, paid with the tutor's last three credits, its profile
   entry carrying a verification of its own and that reputation proof. The index shows the proof on
   the coach's page, with the tutor's trust.
10. **Removed.** The tutor's app takes the access key out of the tutor's profile entry. The tutor's
    AI's next write is refused by the host, as `unlisted`, and the offer the key wrote counts for
    nothing on the host: the newest entry that still counts at its path is current, and there is
    none.
11. **A new device.** From the tutor's seed alone, the Profiles folder on the host gives its two
    profiles, `tutoring/tutor` and `sports-coaching/coach`, each with its folder there, and its
    stamp, the one signed.
12. **Addresses.** No answer either AI received holds one of its own person's addresses: each of
    their profiles, the coach's included, each pay address, and their Profiles folder. An AI reads
    the other person's addresses, as it must to message and review them.
13. **Balances.** What each folder's credits came to.

Then, passed or failed, the services stop, and the run exits 0 or 1.

### The loop and the deployed check

`services.json` names what a run uses:
- each service's address (`verifier`, `host`, `index`, `mcp`), where `null` means the loop's own
  copy;
- the market.

As committed, every service is `null`: the loop starts its own copy of each on loopback, from this
repo's folders (`services.ts`), and runs.

| Service | The loop's own copy |
|---|---|
| verifier | `verifier/`'s code, with the stand-in Didit its tests run (`verifier/test/fake-didit.ts`) and the stand-in face model. Its own name, `verifier.e2e-loop.invalid`, and its own seed. Its welcome gift, `HOST_CREDITS` unset so 10, at the loop's host |
| host | `host/`'s code, as `npm start` runs it, the plug and the credits, its `SPONSORS` the loop verifier's sponsor key, so the gift's tickets buy its credits. Its port is picked first, so the verifier's gift can name it |
| index | `index/`'s code, with lists of its own: the host; the loop verifier's two keys in `lists/verifiers.json` (face check at confidence 0.75, ID check at 0.95, as the index's own lists give the foundation's); its own reputation proofs, against a root up to 30 days old. Its numbers are `index/config/`'s |
| mcp | `mcp/`'s code, reading the loop's index and the markets, with the loop's connect page as its `APP_URL`, and reaching hosts with a plain fetch, since the loop's host is on loopback |

A `services.json` that names any service by its origin is the deployed check instead: each one
named is checked to answer, and no loop runs. The loop never runs against a deployed service:
- a deployed verifier checks real faces, and a script has none;
- a deployed host takes only its own sponsors' tickets;
- a deployed index trusts only that verifier;
- the deployed mcp has no connect page (its `APP_URL` is unset), so no AI can log in there.

So against every deployed service, a copy of `services.json` names
`https://verifier.forest.foundation`, `https://host.forest.foundation`,
`https://index.forest.foundation` and `https://mcp.forest.foundation`, and the check reads: the
verifier says its name and two keys, the host its credit directory, the index answers, and the mcp,
through the MCP SDK's client with no login, lists its tools and reads the markets.

Each process the loop starts gets only the settings it needs.

### The files

- `e2e.ts`: the run, step by step; each person's AI; the connect page; the deployed check's run.
- `services.ts`: reads `services.json`, starts and stops the loop's own copies, and checks the
  deployed ones.

The loop buys its credits with the host's credits client,
[`host/client/`](../host/client/client.ts), as the verifier's tests do.

### Run it

Node 22.18 or later. From the repo root:

```sh
./standard.sh                                             # the standard and the markets, at their pins
(cd verifier && npm ci) && (cd host && npm ci) && (cd index && npm ci) && (cd mcp && npm ci)
cd e2e && npm ci
npm run check && npm test                                 # what CI's e2e job runs
npm run e2e                                               # the loop, on loopback: what CI's loop job runs
npm run e2e -- deployed.json                              # the deployed check, of what deployed.json names
```

No setting: the loop needs no phrase, no RPC and no key.

The tests, which CI runs:
- `test/credits.test.ts`:
  - the host's credits client against the host's own code, on loopback, selling for its sponsors'
    tickets: a ticket collected, any other proof refused, the credits spent into a folder, and spent
    once;
  - the client alone, against Cloudflare's own Privacy Pass issuer.

### Its record

CI runs the loop on every pull request, as its own job, `loop`, and its log is the record: what each
step did, with the addresses, the keys, the index's numbers and the balances it found. The loop's
own services stop with the run, so their pages and the three profiles' entries are gone.

## Promises

- **No key, phrase or keyed URL (a web address with a key inside) in this directory,** and none in
  a run: the loop takes no setting. What it prints holds only public things: addresses, counts,
  labels, the index's numbers, a buy's reference, a refusal's text, and the loop's own page
  addresses on loopback; never a seed, a key's secret, a credit or a login.
- **It does what a person's device and their AI would,** with stand-ins only for Didit, the face
  model and the Forest app's connect page, and with the standard's own pieces, the reference app,
  the MCP SDK's client and the credits client: keys and access keys, folders and the Profiles
  folder, the verification and the reputation proof. Nothing in it reaches around a service.
- **A run passes only if every step passed.** A failed run prints the error and exits 1.

## Limits

- **The checks are stand-ins.** The stand-in Didit passes everyone, and the stand-in face model
  gives everyone one embedding, so a run says nothing about Didit or the face model. Only the face
  check: no one in the loop takes the ID check.
- **The connect page is a stand-in.** The loop ticks the profile for each person, with every switch,
  so a run says nothing about the Forest app's own page. Against the deployed mcp, which has none
  yet, the deployed check only checks that the mcp answers.
- **The deployed check runs no loop.** It says each deployed service answers, nothing more.
- **No payment, and one review.** No money moves: the review names the offer and nothing else. Only
  the student rates.
- **One host, inboxes of any size.** Both people are on the same host, so each finds the other's
  folder there.
- **Each wait on the index is up to 2 minutes.** The loop index reads every 5 seconds.

## Who decides what

- **The standard:** what each step makes and checks: keys and access keys, entries, folders and the
  Profiles folder, messages, the verification and the reputation proof.
- **The markets directory, at `MARKETS`:** what the offer and the review hold.
- **The mcp, as this repo writes it:** its tools, the login and the pack.
- **Each service, by its own choice:** what it takes and what it charges. The loop checks it as it
  runs.
- **The index, by its own numbers:** each rating, trust and uniqueness. The loop expects what those
  numbers make of its one review.
- **The foundation:** what `services.json` names, what the loop's own copies are set to
  (`services.ts`), and what each person in it lets their AI do (`e2e.ts`).

## FAQ

**Why does the loop always run its own verifier, host, index and mcp?**
A deployed verifier is real: every stamp it signs needs a face that passed Didit, and a script has
none. A deployed host takes only its own sponsors' tickets, and the loop's verifier is not one. A
deployed index trusts only that verifier. The deployed mcp has no connect page yet, so no AI can log
in there. So the loop runs all four from this repo's code, the verifier with a stand-in Didit and a
seed of its own.

**Why does the loop start the verifier, host, index and mcp in its own process?**
The index takes lists of its own only from its start function, not from a setting, and the mcp
reaches a loopback host only through a setting its start function takes. The others are started the
same way, each from its own folder's start function and code, unchanged, so one place starts and
stops them all.

**Why is the tutor's trust 44, and the student's 38?**
A newcomer's trust is half its uniqueness, 38: the student, whom no one rated. The student's review
is also its word about the tutor, a vouch, weighing the student's uniqueness times trust, 0.75 times
0.375; one such vouch lifts the tutor to 44. The loop works out what the index's own ranking and
numbers make of its one review, and checks the index shows exactly that.
