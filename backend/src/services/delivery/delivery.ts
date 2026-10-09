import { DeliveryService } from './DeliveryService.js'
import { SolanaDeliveryChain } from './SolanaDeliveryChain.js'
import { MongoDeliveryLease, memoryDeliveryLease } from './DeliveryLease.js'
import { storageMode } from '../../persistence/mongo.js'
let instance: DeliveryService | undefined
export const deliveryLeases = new MongoDeliveryLease()
export function deliveryService() { return instance ??= new DeliveryService(new SolanaDeliveryChain(), undefined, undefined,
  undefined, undefined, undefined, undefined, storageMode() === 'mongo' ? deliveryLeases : memoryDeliveryLease) }
