# e2e

The loop runs two people through all four services, end to end: each with their app, on a device of
their own holding their seed, and an AI that acts for them through the mcp, a connector, over MCP
(the way AI apps call outside tools). It is not a service. CI runs it on every pull request, and
anyone can; the main way is `npm run e2e`, with no chain and no secret.

## How it works

- **Each device** is the reference app, [`mcp/test/app.ts`](../mcp/test/app.ts), unchanged: it holds
  the seed and the stamp, keeps the Profiles folder (the empty label's folder, locked to a key only
  the seed gives, listing the person's profiles and stamps), makes each profile with a verification,
  signs with its main key, writes straight to the host, and makes the AI's connection. What it has no
  method for, `e2e.ts` does with the standard's pieces: asking the stamp with its welcome gift,
  collecting the gift's credits, and making the reputation proof.
- **Each AI** is the MCP SDK's own client, through mcp's test helpers (`aiApp`, `logIn`, in
  [`mcp/test/setup.ts`](../mcp/test/setup.ts)). It logs in as an AI app does and calls the tools as a
  chat does. It holds no key and is told no address of its own person's.
- **The connect page** is a stand-in for the Forest app's, in `e2e.ts`: the person ticks the profile
  their AI acts in, and their app makes the connection.

### What one run does

A tutor who sells and a student who buys, each from a seed of their own, in `tutoring`. Every step
checks what it did, and the run passes only if every step does.

1. **Keys:** each seed's profile, `tutoring/tutor` or `tutoring/student`, with its address and pay
   addresses `{ solana, evm }`, and its stamp number at the loop verifier's name; the tutor's seed
   also gives `sports-coaching/coach`.
2. **Stamps:** each takes the face check, asking with the gift: one buy of the verifier's 10 credits
   with the host's credits client (`host/client/`). Each stamp is checked (signature, face key, stamp
   number, verifier name), the gift's ticket too, then asked back by its stamp number (`POST /stamp`)
   and found the same.
3. **Credits:** each app collects its buy at the host with the ticket and finishes its 10 credits.
4. **Profiles:** each spends 2 credits into the Profiles folder, all but one into the profile's
   folder (the tutor 3 more, for the coach), and adds the profile. Read back, the profile entry holds
   the market, role, open key and pay addresses, and a verification that checks.
5. **Logins:** each AI's first act gets the challenge; the person ticks their tutoring profile, and
   the app makes the connection folder (its first write paid with the credit kept), an access key
   with all four switches, its note and its access entry, and hands over the pointer. Read back: one
   access key listed; its note at `key/<id>`, locked to the main key alone, naming the key and this
   mcp and holding the connection folder's key; and the connection found from the seed, its entry
   locked to its own key and the mcp's.
6. **mcp:** the tutor's AI reads `markets` and writes a post, `post/maths`, 2 USD an hour, signed by
   its access key; the student's AI finds it with `search` and messages the tutor; the tutor's AI
   reads its inbox (the message counted, with the student's market, role and face check as the index
   shows them) and replies; the student's AI reads the reply.
7. **The review:** the student's AI writes `review/maths`, scoring the tutor 10 and naming the post.
8. **The index** shows both profiles counted under the face key, the post listed, the review counted,
   and what its own ranking, with `index/config/scoring.json`, makes of it: today the tutor rated 10.0 by one, trust 44; the student no
   rating, trust 38; each uniqueness 75. Each statement is signed and checked. No message appears in
   its JSON.
9. **The trust, carried:** the tutor's device finds its leaf, checks the signed root, and proves its
   tutoring trust onto the coach profile (the standard's reputation circuit), naming none of its
   profiles; the app adds the coach profile with the last three credits, and the index shows the
   proof on the coach's page.
10. **Added:** from the seed alone, the tutor's app adds the coach to the connection; with no new
    login, `my_profiles` shows both, and the AI writes and reads back a locked note as the coach.
11. **Ended:** the app deletes the connection entry and removes each key; the mcp answers the AI
    401, and what the keys wrote counts for nothing on the host.
12. **A new device:** from the tutor's seed alone, the Profiles folder gives both profiles, each with
    its folder, and its stamp.
13. **Addresses:** no answer either AI got holds one of its own person's addresses (profiles, pay
    addresses, Profiles folder, connection folder); each reads the other's, as it must.
14. **Balances:** what each folder's credits came to.

Then, passed or failed, the services stop, and the run exits 0 or 1.

### The loop's own copies, and the deployed check

As committed, `services.json` names every service `null`, so the loop starts its own copy of each on
loopback from this repo's folders (`services.ts`), each from its own start function and code,
unchanged, with only the settings it needs:

| Service | The loop's own copy |
|---|---|
| verifier | `verifier/`'s code, with the stand-in Didit its tests run and the stand-in face model; its own name, `verifier.e2e-loop.invalid`, and seed; its gift, 10 credits at the loop's host |
| host | `host/`'s code as `npm start` runs it, its `SPONSORS` the loop verifier's sponsor key; its port is picked first, so the gift can name it |
| index | `index/`'s code with lists of its own: the host, the loop verifier's keys at 0.75 and 0.95, its own proofs against a root up to 30 days old; its numbers from `index/config/` |
| mcp | `mcp/`'s code, reading the loop's index and the markets, the loop's connect page as `APP_URL`, and a plain fetch for hosts, since `publicFetch` refuses loopback |

The index takes its lists only from its start function, and the mcp reaches a loopback host only
through a setting its start function takes, so the loop starts all four in its own process.

A `services.json` that names any service by its origin is the deployed check instead: each one named
is checked to answer, and no loop runs. The loop never runs against a deployed service: a deployed
verifier checks real faces, which a script has none of; a deployed host takes only its own sponsors'
tickets; a deployed index trusts only that verifier; and the deployed mcp has no connect page yet.
Against all four (each `https://<name>.forest.foundation`), the check reads the verifier's name and keys, the host's credit directory, the
index's answer, and, through the MCP SDK's client with no login, the mcp's tools and markets.

## Its API

| Command or file | What |
|---|---|
| `npm run e2e` | The loop, on loopback |
| `npm run e2e -- <file>` | The run `<file>` names, in `services.json`'s form |
| `services.json` | `verifier`, `host`, `index`, `mcp`: each an origin, or `null` for the loop's own copy; `market`: the market the two people deal in |

## How we run it

```sh
./standard.sh                                             # from the repo root: the standard and the markets, at their pins
(cd verifier && npm ci) && (cd host && npm ci) && (cd index && npm ci) && (cd mcp && npm ci)
cd e2e && npm ci
npm run check && npm test                                 # what CI's e2e job runs
npm run e2e                                               # the loop: what CI's loop job runs
npm run e2e -- deployed.json                              # the deployed check, of what deployed.json names
```

No setting: no phrase, no RPC, no key. `e2e.ts` is the run, the AIs, the connect page and the
deployed check; `services.ts` starts, stops and checks the services. CI runs the loop on every pull
request as its own job, `loop`, whose log says what each step did, with the addresses, keys, index
numbers and balances it found; the loop's services stop with the run, so their pages are gone.
`test/` covers the host's credits client against the host's own code selling for tickets, and alone
against Cloudflare's own Privacy Pass issuer.

## Promises

- **No key, phrase or keyed URL (a web address with a key inside) in this directory,** and none in a
  run: the loop takes no setting. What it prints holds only public things: addresses, counts, labels,
  the index's numbers, a buy's reference, a refusal's text, and its own page addresses on loopback;
  never a seed, a key's secret, a credit or a login.
- **It does what a person's device and their AI would,** with stand-ins only for Didit, the face
  model and the Forest app's connect page, and with the standard's own pieces, the reference app,
  the MCP SDK's client and the credits client. Nothing in it reaches around a service.
- **A run passes only if every step passed.** A failed run prints the error and exits 1.

## Limits

- **The checks are stand-ins:** a run says nothing about Didit or the face model, and no one takes
  the ID check.
- **The connect page is a stand-in,** ticking every switch: a run says nothing about the Forest app's
  own page.
- **The deployed check runs no loop:** it says each deployed service answers, nothing more.
- **No payment, and one review:** no money moves, and only the student rates.
- **One host:** both people are on it, so each finds the other's folder there.
- **Each wait on the index is up to 2 minutes;** the loop's index reads every 5 seconds.

## FAQ

**Why is the tutor's trust 44, and the student's 38?**
A newcomer's trust is half its uniqueness: 38, the student, whom no one rated. The student's review
is also its word about the tutor, a vouch weighing 0.75 times 0.375, which lifts the tutor to 44.
The loop works this out with the index's own ranking and numbers, and checks the index shows it.
