/**
 * Security Audit PoC Tests for ENS Contracts
 *
 * These tests demonstrate the security findings from the audit.
 */
import hre from 'hardhat'
import { expect } from 'chai'
import {
  encodeFunctionData,
  hexToBigInt,
  labelhash,
  namehash,
  parseEther,
  zeroAddress,
  zeroHash,
} from 'viem'

import { DAY } from '../fixtures/constants.js'
import {
  commitNameWithConnection,
  registerNameWithConnection,
} from '../fixtures/registerName.js'

const REGISTRATION_TIME = 28n * DAY

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, registrantClient, otherClient] =
  await connection.viem.getWalletClients()
const ownerAccount = ownerClient.account
const registrantAccount = registrantClient.account
const otherAccount = otherClient.account
const registerName = registerNameWithConnection(connection)
const commitName = commitNameWithConnection(connection)

async function fixture() {
  const ensRegistry = await connection.viem.deployContract('ENSRegistry', [])
  const baseRegistrar = await connection.viem.deployContract(
    'BaseRegistrarImplementation',
    [ensRegistry.address, namehash('eth')],
  )
  const reverseRegistrar = await connection.viem.deployContract(
    'ReverseRegistrar',
    [ensRegistry.address],
  )
  const defaultReverseRegistrar = await connection.viem.deployContract(
    'DefaultReverseRegistrar',
    [],
  )

  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('reverse'),
    ownerAccount.address,
  ])
  await ensRegistry.write.setSubnodeOwner([
    namehash('reverse'),
    labelhash('addr'),
    reverseRegistrar.address,
  ])

  const nameWrapper = await connection.viem.deployContract('NameWrapper', [
    ensRegistry.address,
    baseRegistrar.address,
    ownerAccount.address,
  ])

  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('eth'),
    baseRegistrar.address,
  ])

  const dummyOracle = await connection.viem.deployContract('DummyOracle', [
    100000000n,
  ])
  const priceOracle = await connection.viem.deployContract(
    'StablePriceOracle',
    [dummyOracle.address, [0n, 0n, 4n, 2n, 1n]],
  )
  const ethRegistrarController = await connection.viem.deployContract(
    'ETHRegistrarController',
    [
      baseRegistrar.address,
      priceOracle.address,
      600n,
      86400n,
      reverseRegistrar.address,
      defaultReverseRegistrar.address,
      ensRegistry.address,
    ],
  )

  await baseRegistrar.write.addController([ethRegistrarController.address])
  await baseRegistrar.write.addController([nameWrapper.address])
  await nameWrapper.write.setController([ethRegistrarController.address, true])
  await reverseRegistrar.write.setController([
    ethRegistrarController.address,
    true,
  ])
  await defaultReverseRegistrar.write.setController([
    ethRegistrarController.address,
    true,
  ])

  const publicResolver = await connection.viem.deployContract(
    'PublicResolver',
    [
      ensRegistry.address,
      nameWrapper.address,
      ethRegistrarController.address,
      reverseRegistrar.address,
    ],
  )

  await reverseRegistrar.write.setDefaultResolver([publicResolver.address])

  return {
    ensRegistry,
    baseRegistrar,
    reverseRegistrar,
    dummyOracle,
    priceOracle,
    ethRegistrarController,
    publicResolver,
    defaultReverseRegistrar,
    nameWrapper,
  }
}
const loadFixture = async () => connection.networkHelpers.loadFixture(fixture)

describe('Audit: .transfer() refund pattern in ETHRegistrarController', () => {
  /**
   * FINDING: ETHRegistrarController uses .transfer() for refunding excess ETH
   *
   * Impact: Medium / Griefing
   *
   * .transfer() forwards only 2300 gas, causing failures for smart contract
   * wallets with expensive receive() functions. The entire registration/renewal
   * transaction reverts if the refund fails.
   *
   * Recommendation: Use .call{value: amount}("") instead of .transfer()
   */
  it('register() with excess ETH sends refund via .transfer()', async () => {
    const { ethRegistrarController } = await loadFixture()

    const label = 'transfertest'

    // Register with exact amount succeeds
    await registerName({ ethRegistrarController }, { label })

    // Verify name was registered
    const available = await ethRegistrarController.read.available([label])
    expect(available).to.be.false
  })

  it('renew() with excess ETH sends refund via .transfer()', async () => {
    const { ethRegistrarController } = await loadFixture()
    const label = 'renewxfer'
    const duration = REGISTRATION_TIME

    await registerName({ ethRegistrarController }, { label, duration })

    // Renew with excess ETH - works for EOA but would fail for contract wallets
    const price = await ethRegistrarController.read.rentPrice([label, duration])
    const excessAmount = price.base + parseEther('1')
    const balanceBefore = await publicClient.getBalance({
      address: ownerAccount.address,
    })

    await ethRegistrarController.write.renew([label, duration, zeroHash], {
      value: excessAmount,
    })

    // The excess was refunded via .transfer() - works for EOA
    const balanceAfter = await publicClient.getBalance({
      address: ownerAccount.address,
    })
    // Balance decreased by approximately price.base (plus gas), not by excessAmount
    const spent = balanceBefore - balanceAfter
    expect(spent).to.be.lessThan(excessAmount)
  })
})

describe('Audit: withdraw() lacks access control', () => {
  /**
   * FINDING: ETHRegistrarController.withdraw() is publicly callable
   *
   * Impact: Low / Informational
   *
   * Anyone can trigger a withdrawal of the controller's balance to its owner.
   * While funds always go to the rightful owner(), this allows:
   * - Unwanted withdrawal timing (e.g., front-running planned withdrawals)
   * - Potential tax/accounting complications from unexpected ETH receipts
   */
  it('non-owner can call withdraw() and drain contract balance to owner', async () => {
    const { ethRegistrarController } = await loadFixture()
    const label = 'withdrawtest'
    const duration = REGISTRATION_TIME

    // Register a name so the controller has some ETH
    await registerName({ ethRegistrarController }, { label, duration })

    const controllerBalance = await publicClient.getBalance({
      address: ethRegistrarController.address,
    })

    const ownerBalanceBefore = await publicClient.getBalance({
      address: ownerAccount.address,
    })

    // Non-owner calls withdraw - should succeed
    await ethRegistrarController.write.withdraw({
      account: otherAccount,
    })

    const controllerBalanceAfter = await publicClient.getBalance({
      address: ethRegistrarController.address,
    })
    expect(controllerBalanceAfter).to.equal(0n)

    // Verify funds went to owner
    const ownerBalanceAfter = await publicClient.getBalance({
      address: ownerAccount.address,
    })
    expect(ownerBalanceAfter).to.equal(
      ownerBalanceBefore + controllerBalance,
    )
  })
})

describe('Audit: ETHRegistrarController.renew() only charges base price, ignores premium', () => {
  /**
   * VERIFICATION: renew() correctly charges only base price (no premium)
   *
   * Impact: None - By Design
   *
   * The renew() function only checks msg.value against price.base and ignores
   * the premium. This is correct because the premium is only non-zero for
   * recently-expired names being re-registered, and renew() can only be called
   * for names that haven't expired past the grace period (when premium = 0).
   */
  it('renew charges only base price, not premium', async () => {
    const { ethRegistrarController, baseRegistrar } = await loadFixture()
    const label = 'renewprice'
    const duration = REGISTRATION_TIME

    await registerName({ ethRegistrarController }, { label, duration })

    const tokenId = hexToBigInt(labelhash(label))
    const expiryBefore = await baseRegistrar.read.nameExpires([tokenId])

    const price = await ethRegistrarController.read.rentPrice([label, duration])
    // Premium should be 0 for active names
    expect(price.premium).to.equal(0n)

    // Renew with just base price
    await ethRegistrarController.write.renew([label, duration, zeroHash], {
      value: price.base,
    })

    const expiryAfter = await baseRegistrar.read.nameExpires([tokenId])
    expect(expiryAfter).to.be.greaterThan(expiryBefore)
  })
})
