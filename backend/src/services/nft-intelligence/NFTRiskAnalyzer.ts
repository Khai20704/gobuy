import type { NFTMarketFeatures } from '@gobuy/shared'
import { clamp } from './NFTMomentumScorer.js'
export class NFTRiskAnalyzer {
  analyze(f: NFTMarketFeatures) {
    let risk = 0
    const warnings = [...f.warnings]
    const add = (penalty: number, message: string) => { risk += penalty; warnings.push(message) }
    if (f.liquidityScore === undefined) add(20, 'Chưa đủ dữ liệu thanh khoản.')
    else if (f.liquidityScore < 20) add(40, 'Thanh khoản cực thấp.')
    if (f.sales24h !== undefined && f.sales24h < 3) add(25, 'Rất ít giao dịch trong 24h.')
    if ((f.volumeChange24h ?? 0) > 300 && ((f.salesChange24h ?? 0) < 30 || (f.uniqueBuyers24h ?? 0) < 5)) add(30, 'Volume tăng bất thường so với số giao dịch/người mua; cần kiểm tra wash trading.')
    if (f.selfTradeRatio !== undefined && f.selfTradeRatio > 0.1) add(40, 'Có dấu hiệu người mua trùng người bán.')
    if (f.topSellerShare !== undefined && f.topSellerShare > 0.6) add(20, 'Giao dịch tập trung ở một người bán.')
    if (f.listedRatio !== undefined && f.listedRatio > 0.6) add(15, 'Tỷ lệ NFT đang niêm yết cao.')
    if (f.supply !== undefined && f.supply < 50) add(15, 'Collection rất nhỏ.')
    if (f.collectionVerified !== true) add(15, 'Danh tính collection chưa được xác minh độc lập.')
    if (f.observations < 5 || f.coverage !== 'complete') add(15, 'Chưa đủ quan sát thị trường.')
    return { risk: clamp(risk), warnings }
  }
}
