import { deliveryLeases, deliveryService } from './delivery.js'
import { storageMode } from '../../persistence/mongo.js'
import type { DeliveryPlan } from './DeliveryService.js'
import { recoverAutonomousDeliveryQueue } from './AutonomousDeliveryQueue.js'

/** One batch at a time, no overlapping intervals; leases coordinate other processes and manual checks. */
export function startDeliveryWorker(dependencies: {
  due(): Promise<Array<{ userId: string; value: DeliveryPlan }>>;
  deliver(user: string, plan: DeliveryPlan): Promise<void>;
} = {
  due: async () => { await recoverAutonomousDeliveryQueue(); return deliveryLeases.due() },
  deliver: async (user: string, plan: DeliveryPlan) => {
    const { metadataId: _, ...input } = plan
    await deliveryService().deliver(user, input)
  },
}, interval = 10000, initialDelay = 1000) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  let current: Promise<void> = Promise.resolve()
  const tick = async () => {
    try {
      const rows = await dependencies.due()
      for (const row of rows) {
        if (stopped) break
        try { await dependencies.deliver(row.userId, row.value) }
        catch { console.warn('[DeliveryWorker] Recovery deferred; database or lease unavailable.') }
      }
    } catch { console.warn('[DeliveryWorker] Unable to load pending deliveries; will retry.') }
    finally {
      if (!stopped) { timer = setTimeout(() => { current = tick() }, interval); timer.unref() }
    }
  }
  timer = setTimeout(() => { current = tick() }, initialDelay); timer.unref()
  return async () => { stopped = true; clearTimeout(timer); await current }
}
export function startPersistentDeliveryWorker() {
  if (process.env.DEVNET_DELIVERY_LIVE_ENABLED !== 'true') {
    console.info('[DeliveryWorker] Live delivery disabled; no transactions will be sent.')
    return async () => {}
  }
  if (storageMode() !== 'mongo') {
    console.warn('[DeliveryWorker] Automatic recovery requires MongoDB; file development mode supports manual checks only.')
    return async () => {}
  }
  return startDeliveryWorker()
}
