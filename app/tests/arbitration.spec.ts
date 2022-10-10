import { TextDecoder, TextEncoder } from 'util'

import dotenv from 'dotenv'
import { jest } from '@jest/globals'
import offers from './fixtures/offers.json'
import { setupProtocol } from './utils'
import type { TestCosmosChain } from './network/TestCosmosChain'
import { encryptDataMocked } from './helper'
import takerSecrets from './fixtures/taker_secrets.json'
import makerSecrets from './fixtures/maker_secrets.json'
import type { FiatCurrency, GetOffer, PostOffer } from '~/types/components.interface'
import { TradeState } from '~/types/components.interface'

dotenv.config()
Object.assign(global, { TextEncoder, TextDecoder })

let makerClient: TestCosmosChain
let takerClient: TestCosmosChain
let adminClient: TestCosmosChain

const takerContact = 'taker001'
const makerContact = 'taker001'

jest.setTimeout(30 * 1000)
beforeAll(async () => {
  const result = await setupProtocol()
  makerClient = result.makerClient
  takerClient = result.takerClient
  adminClient = result.adminClient
})

let offer: GetOffer

describe('arbitration tests', () => {
  it('should have an arbitrator available', async () => {
    const fiat = offers[0].fiat_currency as FiatCurrency
    let arbitrators = await adminClient.fetchArbitrators()
    if (arbitrators.find((arbitrator) => arbitrator.fiat === fiat) === undefined) {
      await adminClient.newArbitrator({
        arbitrator: adminClient.getWalletAddress(),
        fiat,
        encryption_key: 'arbitrator_encrypt_public_key',
      })
      arbitrators = await adminClient.fetchArbitrators()
    }
    expect(arbitrators.filter((arb) => arb.fiat === fiat).length).toBeGreaterThan(0)
  })
  // Call dispute_escrow on a trade in fiat_deposited state and expects it to be in escrow_disputed state
  it('should have available offers', async () => {
    // Create and fetch offer for trade creation
    const owner_contact = await encryptDataMocked(makerSecrets.publicKey, makerContact)
    const owner_encrypt_key = makerSecrets.publicKey
    const denom = { native: process.env.OFFER_DENOM! }
    const createdOffer = { ...offers[0], owner_contact, owner_encryption_key: owner_encrypt_key, denom } as PostOffer
    if (process.env.CREATE_OFFERS) {
      await makerClient.createOffer(createdOffer)
    }
    const offersResult = await makerClient.fetchOffers({
      denom: createdOffer.denom,
      fiatCurrency: createdOffer.fiat_currency,
      offerType: createdOffer.offer_type,
    })
    offer = offersResult[0] as GetOffer
    expect(offer.id.length).toBeGreaterThan(0)
  })

  it('should settle dispute for taker', async () => {
    const profile_taker_contact = await encryptDataMocked(takerSecrets.publicKey, takerContact)
    const taker_encrypt_pk = takerSecrets.publicKey
    const taker_contact = await encryptDataMocked(offer.owner_encryption_key, takerContact)
    // Create a Trade and set it to `fiat_deposited` state.
    const tradeId = await takerClient.openTrade({
      amount: offer.min_amount,
      offer_id: offer.id,
      taker: takerClient.getWalletAddress(),
      profile_taker_contact,
      profile_taker_encryption_key: taker_encrypt_pk,
      taker_contact,
    })

    let trade = await makerClient.fetchTradeDetail(tradeId)
    const makerContactEncrypted = await encryptDataMocked(trade.seller_encryption_key, makerContact)
    await makerClient.acceptTradeRequest(tradeId, makerContactEncrypted)
    await takerClient.fundEscrow(trade.id, trade.amount, trade.denom)
    await makerClient.setFiatDeposited(trade.id)
    trade = await takerClient.fetchTradeDetail(trade.id)
    expect(trade.state).toBe(TradeState.fiat_deposited)

    // Taker disputes the escrow
    await takerClient.openDispute(trade.id, 'buyer_contact', 'seller_contact')
    trade = await takerClient.fetchTradeDetail(trade.id)
    expect(trade.state).toBe(TradeState.escrow_disputed)

    // Arbitrator settles for Taker
    await adminClient.settleDispute(trade.id, takerClient.getWalletAddress())
    trade = await takerClient.fetchTradeDetail(trade.id)
    expect(trade.state).toBe(TradeState.settled_for_taker)
  })

  it('should settle dispute for maker', async () => {
    const profile_taker_contact = await encryptDataMocked(takerSecrets.publicKey, takerContact)
    const taker_encrypt_pk = takerSecrets.publicKey
    const taker_contact = await encryptDataMocked(offer.owner_encryption_key, takerContact)

    const tradeId = await takerClient.openTrade({
      amount: offer.min_amount,
      offer_id: offer.id,
      taker: takerClient.getWalletAddress(),
      profile_taker_contact,
      profile_taker_encryption_key: taker_encrypt_pk,
      taker_contact,
    })

    let trade = await makerClient.fetchTradeDetail(tradeId)
    const makerContactEncrypted = await encryptDataMocked(trade.seller_encryption_key, makerContact)
    await makerClient.acceptTradeRequest(tradeId, makerContactEncrypted)
    await takerClient.fundEscrow(trade.id, trade.amount, trade.denom)
    await makerClient.setFiatDeposited(trade.id)

    // Taker disputes the escrow
    await takerClient.openDispute(trade.id, 'buyer_contact', 'seller_contact')
    trade = await takerClient.fetchTradeDetail(trade.id)
    expect(trade.state).toBe(TradeState.escrow_disputed)

    // Arbitrator settles for Maker
    await adminClient.settleDispute(trade.id, makerClient.getWalletAddress())
    trade = await takerClient.fetchTradeDetail(trade.id)
    expect(trade.state).toBe(TradeState.settled_for_maker)
  })

  it('should query trades by arbitrator', async () => {
    const tradesByArbitrator = await takerClient
      .getCwClient()
      .queryContractSmart(takerClient.getHubInfo().hubConfig.trade_addr, {
        trades: {
          user: adminClient.getWalletAddress(),
          role: 'arbitrator',
          limit: 10,
        },
      })
    expect(tradesByArbitrator.length).toBeGreaterThan(0)
  })

  it('should remove arbitrator', async () => {
    const adminCwClient = adminClient.getCwClient()
    const adminAddr = adminClient.getWalletAddress()
    const tradeAddr = adminClient.getHubInfo().hubConfig.trade_addr
    let arbitrators = await adminCwClient.queryContractSmart(tradeAddr, {
      arbitrators: {
        limit: 10,
      },
    })
    expect(arbitrators.length).toBe(1)
    await adminCwClient.execute(
      adminAddr,
      tradeAddr,
      {
        delete_arbitrator: {
          arbitrator: adminAddr,
          fiat: offer.fiat_currency,
        },
      },
      'auto'
    )
    arbitrators = await adminCwClient.queryContractSmart(tradeAddr, {
      arbitrators: {
        limit: 10,
      },
    })
    expect(arbitrators.length).toBe(0)
  })
})
