import { Router } from 'express'
import type { DiscoveryService } from '../../application/DiscoveryService.js'
import { searchProposals } from '../controllers/proposals.js'
export function proposalRoutes(service: DiscoveryService) {
  const router = Router()
  router.post('/search', searchProposals(service))
  return router
}
