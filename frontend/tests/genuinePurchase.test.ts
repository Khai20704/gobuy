import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { nftPurchaseResultSchema, type DiscoveryReply, type NFTCandidate } from '@gobuy/shared'
import { genuineDeliveryVerified, genuineListingAvailable } from '../src/features/na/genuinePurchase.js'

test('frontend never claims delivery from CONFIRMED status or receipt alone', () => {
  const state = JSON.parse(readFileSync(new URL('../../docs/evidence/step8/step7-pass/docs__evidence__step7__valid-purchase-after-state.json',import.meta.url),'utf8'))
  const receipt=state.decoded.receipt
  const result=nftPurchaseResultSchema.parse({orderId:receipt.orderId,status:'CONFIRMED',deliveryMode:'ORIGINAL_NFT_TRANSFER',network:'devnet',marketplace:'Tensor',
    mint:receipt.mint,listing:receipt.listing,seller:state.accounts.seller.address,priceLamports:receipt.priceLamports,maxTotalDebitLamports:'110000000',
    signature:'signature',receipt,rejection:null,message:'API says success'})
  assert.equal(genuineDeliveryVerified(result),false)
  result.delivery={owner:receipt.owner,mint:receipt.mint,tokenAccount:state.accounts.buyerAta.address,signature:'signature',slot:1,commitment:'finalized',amount:'1'}
  assert.equal(genuineDeliveryVerified(result),true)
  assert.equal(genuineDeliveryVerified({...result,status:'PENDING'}),false)
  assert.equal(genuineDeliveryVerified({...result,receipt:null}),false)
  assert.equal(genuineDeliveryVerified({...result,delivery:{...result.delivery,owner:receipt.executor}}),false)
})
test('frontend refuses SEARCH, mainnet and missing real listing', () => {
  const discovery={intent:{action:'BUY'}} as DiscoveryReply
  assert.equal(genuineListingAvailable(discovery,{sourceNetwork:'mainnet'} as NFTCandidate),false)
  assert.equal(genuineListingAvailable(discovery,{sourceNetwork:'devnet'} as NFTCandidate),false)
  assert.equal(genuineListingAvailable({intent:{action:'SEARCH'}} as DiscoveryReply,{} as NFTCandidate),false)
})
