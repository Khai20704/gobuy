import { expect, test } from '@playwright/test'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { createNftPurchaseAuthorizationInstruction } from '../../backend/src/services/nft-purchase/nftPurchaseInstructions.js'

test('genuine card signs explicit authorization, purchases once and only displays proven delivery', async ({ page }) => {
  const owner = Keypair.generate(), agent = Keypair.generate().publicKey.toBase58(), program = new PublicKey('CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE')
  const address = owner.publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58(), listing = Keypair.generate().publicKey.toBase58()
  const seller = Keypair.generate().publicKey.toBase58(), now = new Date().toISOString()
  const marketplace = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp'
  const candidate = { id:'tensor:'+mint,provider:'tensor',sourceNetwork:'devnet',mint,name:'Genuine fixture',description:'',image:null,collection:'',attributes:[],
    asset:{mint,owner:listing,network:'devnet',verifiedAt:now},marketplaceListing:{listingId:listing,mint,seller,priceLamports:'100000000',currency:'SOL',marketplace:'Tensor',network:'devnet',status:'LISTED'},
    listing:{seller,priceLamports:'100000000',currency:'SOL',observedAt:now,url:''} }
  const discovery={id:'3f2504e0-4f89-11d3-9a0c-0305e82c3301',intent:{action:'BUY'}}
  let authorized=false,purchases=0,signs=0
  await page.exposeFunction('signFixture', (wire:string) => { signs++;const tx=Transaction.from(Buffer.from(wire,'base64'));tx.sign(owner);return tx.signature!.toString('base64') })
  await page.addInitScript(address => {
    const publicKey={toBase58:()=>address}
    const bridge=window as unknown as {signFixture(wire:string):Promise<string>}
    Object.assign(window,{phantom:{solana:{isPhantom:true,publicKey,connect:async()=>({publicKey}),on:()=>{},removeListener:()=>{},
      signTransaction:async(tx:{serialize(options:unknown):Uint8Array;feePayer:unknown;addSignature(key:unknown,signature:Uint8Array):void})=>{
        const signature=await bridge.signFixture(btoa(String.fromCharCode(...tx.serialize({requireAllSignatures:false,verifySignatures:false}))))
        tx.addSignature(tx.feePayer,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)));return tx
      }}}})
  },address)
  await page.route('**/src/main.tsx*',route=>route.fulfill({contentType:'text/javascript',body:`
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {GenuineNftPurchase,GenuinePurchaseResult} from '/src/features/na/components/GenuineNftPurchase.tsx';
    function App(){const [result,setResult]=React.useState(null);window.fixtureResult=setResult;return React.createElement(React.Fragment,null,
      React.createElement(GenuineNftPurchase,{discovery:${JSON.stringify(discovery)},candidate:${JSON.stringify(candidate)},owner:${JSON.stringify(address)},ready:true,disabled:!!result,
        storageScope:'browser-fixture',onPending:()=>{},onResult:setResult}),result&&React.createElement(GenuinePurchaseResult,{result}));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  `}))
  await page.route('**/src/features/account/firebase.ts*',route=>route.fulfill({contentType:'text/javascript',body:'export const accountFetch=(path,init)=>fetch(path,init);'}))
  await page.route('https://api.devnet.solana.com/**',route=>{
    const req=route.request().postDataJSON()
    return route.fulfill({json:{jsonrpc:'2.0',id:req.id,result:req.method==='getGenesisHash'?'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG':{context:{slot:1},value:true}}})
  })
  await page.route('**/api/mandate?**',route=>route.fulfill({json:{vaultProgramId:program.toBase58(),description:'Fixture',marketplaceExecution:'wallet_signature_required',mandate:{
    address:listing,owner:address,executor:agent,vault:listing,recipient:address,maxBudgetLamports:'500000000',spentLamports:'0',remainingLamports:'500000000',vaultLamports:'500000000',
    expiresAt:Math.floor(Date.now()/1000)+3600,allowedCategory:'NFT',active:true,closed:false,createdAt:1,closedAt:0,status:'ACTIVE'}}}))
  await page.route('**/api/nft-purchases/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname
    if(path.endsWith('/config')) return route.fulfill({json:{network:'devnet',deliveryMode:'ORIGINAL_NFT_TRANSFER',demoFallback:false,liveExecutionEnabled:true}})
    if(path.endsWith('/authorization/submit')) {
      const body=req.postDataJSON();expect(body.maxTotalDebitSol).toBe(0.11)
      expect(Transaction.from(Buffer.from(body.transaction,'base64')).verifySignatures()).toBe(true)
      authorized=true;return route.fulfill({json:{status:'CONFIRMED',signature:'test-signature',message:'Authorization submitted'}})
    }
    if(path.endsWith('/authorization')&&req.method()==='POST') {
      const tx=new Transaction({feePayer:owner.publicKey,blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:123}).add(
        createNftPurchaseAuthorizationInstruction(program,owner.publicKey,{maxTotalDebitLamports:110000000n,expiresAt:Math.floor(Date.now()/1000)+3600,executor:new PublicKey(agent),recipient:owner.publicKey}))
      return route.fulfill({json:{action:'authorize_nft',owner:address,expiresAt:new Date(Date.now()+120000).toISOString(),transaction:tx.serialize({requireAllSignatures:false}).toString('base64')}})
    }
    if(path.endsWith('/authorization')) return route.fulfill({json:{authorization:authorized?{address:listing,version:1,mandate:listing,owner:address,executor:agent,marketplace,recipient:address,
      maxTotalDebitLamports:'110000000',spentLamports:'0',remainingLamports:'110000000',expiresAt:Math.floor(Date.now()/1000)+3600,active:true,createdAt:1,status:'ACTIVE'}:null}})
    purchases++; expect(path.endsWith('/purchase')).toBe(true)
    return route.fulfill({json:{orderId:'00112233445566778899aabbccddeeff',status:'CONFIRMED',deliveryMode:'ORIGINAL_NFT_TRANSFER',network:'devnet',marketplace:'Tensor',
      mint,listing,seller,priceLamports:'100000000',maxTotalDebitLamports:'110000000',signature:'test-signature',receipt:null,delivery:null,rejection:null,message:'Unproven API success'}})
  })
  await page.goto('/')
  await expect(page.getByText('Người bán: '+seller)).toBeVisible()
  await page.getByRole('button',{name:/Ký uỷ quyền NFT/}).click()
  await expect(page.getByRole('button',{name:'Mua NFT gốc trên Devnet'})).toBeEnabled()
  await page.getByRole('button',{name:'Mua NFT gốc trên Devnet'}).click()
  await expect(page.getByText('Chưa đủ bằng chứng giao NFT')).toBeVisible()
  await expect(page.getByText('Đã xác minh giao NFT gốc · finalized')).toHaveCount(0)
  expect(purchases).toBe(1);expect(signs).toBe(1)
  await page.evaluate(({address,mint,listing,seller,agent,marketplace}) => {
    const update=(window as unknown as {fixtureResult(value:unknown):void}).fixtureResult
    update({orderId:'00112233445566778899aabbccddeeff',status:'PENDING',deliveryMode:'ORIGINAL_NFT_TRANSFER',network:'devnet',marketplace:'Tensor',
      mint,listing,seller,priceLamports:'100000000',maxTotalDebitLamports:'110000000',signature:'test-signature',receipt:null,delivery:null,rejection:null,message:'Đang đối soát'})
    Object.assign(window,{verifiedFixture:{orderId:'00112233445566778899aabbccddeeff',status:'CONFIRMED',deliveryMode:'ORIGINAL_NFT_TRANSFER',network:'devnet',marketplace:'Tensor',
      mint,listing,seller,priceLamports:'100000000',maxTotalDebitLamports:'110000000',signature:'test-signature',
      receipt:{address:listing,version:1,mandate:listing,authorization:listing,owner:address,executor:agent,mint,listing,marketplace,priceLamports:'100000000',
        totalDebitLamports:'104039280',orderId:'00112233445566778899aabbccddeeff',timestamp:1},
      delivery:{owner:address,mint,tokenAccount:listing,signature:'test-signature',slot:1,commitment:'finalized',amount:'1'},rejection:null,message:'Đã xác minh'}})
  },{address,mint,listing,seller,agent,marketplace})
  await expect(page.getByText('PENDING',{exact:true})).toBeVisible()
  await page.evaluate(()=>{const fixture=window as unknown as {fixtureResult(value:unknown):void;verifiedFixture:unknown};fixture.fixtureResult(fixture.verifiedFixture)})
  await expect(page.getByText('Đã xác minh giao NFT gốc · finalized')).toBeVisible()
  await expect(page.getByRole('link',{name:'Receipt on-chain ↗'})).toBeVisible()
  expect(purchases).toBe(1)
})
