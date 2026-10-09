// The gift's transaction, one part at a time, against a stand-in RPC that holds one mint: the
// service's token account made if it is not there, then a transfer to it in the token's own program
// and decimals, naming the buy's reference as one more read-only account, as Solana Pay does; in
// SOL, the transfer alone. What `pay` sends is these, signed by the `credits` key; the devnet e2e
// run sends one (e2e/README.md).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js'

import { transfer } from '../src/gift.ts'

const payer = Keypair.generate().publicKey
const service = Keypair.generate().publicKey.toBase58()
const reference = Keypair.generate().publicKey.toBase58()
const mint = Keypair.generate().publicKey

/** An RPC holding one mint, with these decimals, owned by `program`. */
function holding(program: PublicKey, decimals: number): Pick<Connection, 'getAccountInfo'> {
  const data = Buffer.alloc(MINT_SIZE)
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data)
  return { getAccountInfo: (async (address: PublicKey) => (address.equals(mint) ? { owner: program, data, lamports: 1, executable: false } : null)) as never }
}

for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
  test(`a token in ${program.equals(TOKEN_PROGRAM_ID) ? 'SPL Token' : 'Token-2022'}: the service's account, then the transfer naming the reference`, async () => {
    const [create, pay] = await transfer(holding(program, 6), payer, { address: service, mint: mint.toBase58(), amount: '1.5', reference })
    const into = getAssociatedTokenAddressSync(mint, new PublicKey(service), true, program)
    assert.ok(create!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    assert.deepEqual([...create!.data], [1], 'create, idempotent: an account already there is left as it is')
    assert.ok(create!.keys[1]!.pubkey.equals(into))
    assert.ok(pay!.programId.equals(program))
    const data = Buffer.from(pay!.data)
    assert.deepEqual([data[0], data.readBigUInt64LE(1), data[9]], [12, 1_500_000n, 6], 'transfer checked: 1.5 in six decimals')
    assert.deepEqual(
      pay!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [getAssociatedTokenAddressSync(mint, payer, false, program).toBase58(), false, true],
        [mint.toBase58(), false, false],
        [into.toBase58(), false, true],
        [payer.toBase58(), true, false],
        [reference, false, false],
      ],
      'from the credits key’s account to the service’s, the reference last, read-only',
    )
  })
}

test('in SOL, the transfer alone; an amount finer than the token is refused', async () => {
  const [pay, ...rest] = await transfer(holding(TOKEN_PROGRAM_ID, 6), payer, { address: service, mint: 'SOL', amount: '0.002', reference })
  assert.equal(rest.length, 0)
  assert.ok(pay!.programId.equals(SystemProgram.programId))
  assert.equal(Buffer.from(pay!.data).readBigUInt64LE(4), 2_000_000n, 'in lamports')
  assert.deepEqual(pay!.keys.at(-1), { pubkey: new PublicKey(reference), isSigner: false, isWritable: false })
  await assert.rejects(transfer(holding(TOKEN_PROGRAM_ID, 2), payer, { address: service, mint: mint.toBase58(), amount: '0.005', reference }), /decimal places/)
})
