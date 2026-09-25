import { MAX_IMAGE_BYTES, searchSchema, type SearchRequest } from '@gobuy/shared'

export class InputError extends Error {}
export function parseSearch(body: unknown): SearchRequest {
  const result = searchSchema.safeParse(body)
  if (!result.success) throw new InputError('Invalid request. Use text up to 2000 characters and an optional PNG/JPEG/WebP up to 2 MiB.')
  const request = result.data
  if (request.image) {
    const bytes = Buffer.from(request.image.base64, 'base64')
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new InputError('Image must be between 1 byte and 2 MiB.')
    const matches = request.image.mimeType === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : request.image.mimeType === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!matches) throw new InputError('Image signature does not match its MIME type.')
  }
  return request
}
