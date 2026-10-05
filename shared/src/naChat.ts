import { z } from 'zod'

const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
export type NaChatKind = 'greeting' | 'explanation' | 'ranking' | 'question'

// Route conversation separately from discovery; a question must never create a quote.
export function naChatKind(text: string, hasContext = false): NaChatKind | undefined {
  const value = normalize(text).trim()
  if (/^(?:(?:hey|hi|hello|chao|xin chao|alo|cam on|thanks|thank you|na oi|ban oi)\b[\s!.,]*)+(?:na|ban)?[\s!.,?]*$/.test(value)) return 'greeting'
  if (/\b(sao.*(?:loi|khong|chua)|why.*(?:fail|error|cannot|can't)|khong.*(?:tra loi|phan hoi)|khong hieu)\b/.test(value)) return 'explanation'
  if (/\b(tai sao|vi sao|why|la gi|nghia la gi|giai thich|huong dan|cach (?:mua|dung|ket noi)|what is|what are|explain|how (?:do|does|to)|ban (?:la ai|lam duoc gi)|na (?:la ai|lam duoc gi))\b/.test(value)) return 'question'
  if (/\b(dung so\s*1|so mot|top\s*1|number one|best|tot nhat|dang mua nhat)\b/.test(value)
    && !/\b(?:mua|buy|purchase)\b.*\d+(?:[.,]\d+)?\s*sol\b/.test(value)
    && !/\b(hiem|rarity|rarest|re nhat|gia thap|cheapest|lowest price|mua nhieu|most bought|momentum|thanh khoan|liquidity|trending|xu huong)\b/.test(value)) return 'ranking'
  if (!/\b(nft|tranh|art|artwork|mua|buy|purchase|tim|find|collection|bo suu tap|sol)\b/.test(value)) {
    const refinement = /\b(thu lai|kiem tra lai|retry|try again|another|hiem|rarity|rare|rarer|re hon|cheaper|less expensive|toi hon|toi mau|darker|more dark|sac so|nhieu mau|colorful|colourful|gia thap|re nhat|cheapest|lowest price|thanh khoan|liquidity|momentum|trending|xu huong)\b/.test(value)
    if (!hasContext || !refinement) return 'question'
  }
  return undefined
}

export const naChatReplySchema = z.object({
  message: z.string().min(1).max(4000), kind: z.enum(['greeting', 'explanation', 'ranking', 'question']),
  mode: z.enum(['assistant', 'local']),
})
export type NaChatReply = z.infer<typeof naChatReplySchema>
