import { pageContextSchema } from '@gobuy/shared'
export function supportedPage(url: string) {
  return pageContextSchema.safeParse({ classification: 'UNTRUSTED_EXTERNAL_CONTENT', url, title: '' }).success
}
export const validatePageContext = (value: unknown) => pageContextSchema.parse(value)
