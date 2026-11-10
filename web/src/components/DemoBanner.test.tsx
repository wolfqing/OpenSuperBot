import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { ConnectionsState, ModelConnection } from '../types'
import { BotModelChip, botModel } from './BotModelPicker'
import { DemoBanner } from './DemoBanner'

const main: ModelConnection = {
  id: 'main', name: '', provider: '', api: 'chat', baseURL: 'https://api.x.ai/v1', model: 'stub', vision: false,
  builtIn: true, key: { set: false, masked: '', source: 'none' }, locked: [],
}
const claude: ModelConnection = { ...main, id: 'c-12345678', name: 'Claude', provider: 'anthropic', model: 'claude-opus-5-5', builtIn: false }

describe('demo mode', () => {
  it('works out which model a teammate really uses', () => {
    const state: ConnectionsState = {
      connections: [main, claude],
      bots: { researcher: { connectionId: 'c-12345678', model: 'claude-haiku-5-5' }, ticker: { connectionId: 'c-12345678', model: null }, gone: { connectionId: 'c-deleted0', model: null } },
    }
    expect(botModel(state, 'chief')).toBe('stub') // 没单独选：默认连接的默认模型
    expect(botModel(state, 'researcher')).toBe('claude-haiku-5-5')
    expect(botModel(state, 'ticker')).toBe('claude-opus-5-5')
    expect(botModel(state, 'gone')).toBe('stub') // 连接不在了：退回默认连接
  })

  it('says so on the model chip instead of naming a service', () => {
    render(<BotModelChip botId="chief" state={{ connections: [main], bots: {} }} providers={[]} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: 'Demo mode' })).toBeInTheDocument()
  })

  it('the banner explains the replies and offers a real model', async () => {
    const onConnect = vi.fn()
    render(<DemoBanner onConnect={onConnect} />)
    expect(screen.getByText(/Replies here are scripted/)).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect a real model' }))
    expect(onConnect).toHaveBeenCalled()
  })

  it('in a group, names who is in demo mode; in Chinese too', () => {
    render(<I18nProvider lang="zh-CN"><DemoBanner names={['Scout', 'Ticker']} onConnect={() => {}} /></I18nProvider>)
    expect(screen.getByText('Scout、Ticker 在演示模式：回复是脚本写好的，不花钱，也不连任何 AI 服务。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '接真模型' })).toBeInTheDocument()
  })
})
