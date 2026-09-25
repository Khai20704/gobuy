import type { RequestHandler } from 'express'
import type { DiscoveryService } from '../../application/DiscoveryService.js'
import { parseSearch } from '../../schemas/search.js'
export const searchProposals = (service: DiscoveryService): RequestHandler => async (request, response) => {
  const input = parseSearch(request.body)
  const result = await service.search(input)
  response.json(result)
}
