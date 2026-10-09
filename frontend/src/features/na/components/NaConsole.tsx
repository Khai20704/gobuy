import { useState, type ReactNode } from 'react'

/**
 * The Na side console: Ngân sách / Ví & tài sản / Lịch sử.
 *
 * Account panels are mounted only while Phantom is connected.
 */

type ConsoleTabId = 'budget' | 'assets' | 'history'

const CONSOLE_TABS: ReadonlyArray<{ id: ConsoleTabId; label: string; hint: string }> = [
  { id: 'budget', label: 'Ngân sách', hint: 'Hạn mức Na được phép chi' },
  { id: 'assets', label: 'Ví & tài sản', hint: 'Ví đã liên kết và tài sản' },
  { id: 'history', label: 'Lịch sử', hint: 'Yêu cầu và khoản chi đã lưu' },
]

function ConsoleIcon({ name }: { name: ConsoleTabId }) {
  if (name === 'budget') return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z" fill="none" stroke="currentColor" strokeWidth="1.6"/>
    <path d="M3 10h18M16 14h2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
  if (name === 'assets') return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    <path d="M4 7l8 4 8-4M12 21V11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
  </svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 21a9 9 0 1 0-9-9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    <path d="M3 12H1m2 0 2-2m-2 2 2 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
}

export function NaConsole({ budget, assets, history, walletConnected }: { budget: ReactNode; assets: ReactNode; history: ReactNode; walletConnected: boolean }) {
  const [tab, setTab] = useState<ConsoleTabId>('budget')
  const panels: Record<ConsoleTabId, ReactNode> = { budget, assets, history }
  const tabs = walletConnected ? CONSOLE_TABS : CONSOLE_TABS.filter(item => item.id === 'budget')
  const selected = walletConnected ? tab : 'budget'
  const active = tabs.find(item => item.id === selected) ?? tabs[0]
  return <section className="na-console" aria-label="Bảng điều khiển Na">
    <header className="na-console-head">
      <div><span className="na-console-eyebrow">BẢNG ĐIỀU KHIỂN</span><p className="na-console-hint">{active.hint}</p></div>
      <span className="na-console-badge">DEVNET</span>
    </header>
    <div className="na-console-tabs" role="tablist" aria-label="Khu vực bảng điều khiển">
      {tabs.map(item => <button key={item.id} type="button" role="tab" id={'na-tab-' + item.id}
        aria-selected={selected === item.id} aria-controls={'na-panel-' + item.id}
        className={'na-console-tab' + (selected === item.id ? ' is-active' : '')} onClick={() => setTab(item.id)}>
        <ConsoleIcon name={item.id}/><span>{item.label}</span>
      </button>)}
    </div>
    <div className="na-console-body">
      {tabs.map(item => <div key={item.id} id={'na-panel-' + item.id} role="tabpanel"
        aria-labelledby={'na-tab-' + item.id} hidden={selected !== item.id}>{panels[item.id]}</div>)}
    </div>
  </section>
}
