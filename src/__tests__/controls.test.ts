import { describe, expect, it } from 'vitest'
import { createReplayGuard, pickFields, type ReplayStore } from '../controls'

function memoryStore(): ReplayStore & { ttls: number[] } {
  const map = new Map<string, string>()
  const ttls: number[] = []
  return {
    ttls,
    async get(key) { return map.get(key) ?? null },
    async put(key, value, options) {
      map.set(key, value)
      if (options?.expirationTtl) ttls.push(options.expirationTtl)
    },
    async delete(key) { map.delete(key) },
  }
}

describe('pickFields', () => {
  const contact = {
    id: 'con_1',
    email: 'renter@example.com',
    first_name: 'Ada',
    phone: '+447700900000',
    date_of_birth: '1990-01-01',
    address: { line1: '1 High St', postcode: 'N1 1AA', country: 'GB' },
  }

  it('copies only the listed fields', () => {
    expect(pickFields(contact, ['email', 'first_name'])).toEqual({ email: 'renter@example.com', first_name: 'Ada' })
  })

  it('keeps the nested shape of a dotted path and nothing beside it', () => {
    expect(pickFields(contact, ['address.postcode'])).toEqual({ address: { postcode: 'N1 1AA' } })
  })

  it('leaves out a listed field the source lacks', () => {
    expect(pickFields(contact, ['email', 'company'])).toEqual({ email: 'renter@example.com' })
  })

  it('returns an empty object for an empty allowlist or a non-object source', () => {
    expect(pickFields(contact, [])).toEqual({})
    expect(pickFields(null, ['email'])).toEqual({})
    expect(pickFields(['email'], ['0'])).toEqual({})
  })

  it('never copies a prototype key', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "email": "a@b.c"}')
    const out = pickFields(hostile, ['__proto__', 'email', 'constructor.prototype'])
    expect(out).toEqual({ email: 'a@b.c' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does not follow inherited properties', () => {
    const child = Object.create({ secret: 'inherited' })
    child.email = 'a@b.c'
    expect(pickFields(child, ['secret', 'email'])).toEqual({ email: 'a@b.c' })
  })
})

describe('createReplayGuard', () => {
  it('accepts an id once and refuses it after', async () => {
    const guard = createReplayGuard({ store: memoryStore() })
    expect(await guard.firstSeen('evt_1', 'ainst_a')).toBe(true)
    expect(await guard.firstSeen('evt_1', 'ainst_a')).toBe(false)
  })

  it('keeps installations apart', async () => {
    const guard = createReplayGuard({ store: memoryStore() })
    expect(await guard.firstSeen('evt_1', 'ainst_a')).toBe(true)
    expect(await guard.firstSeen('evt_1', 'ainst_b')).toBe(true)
  })

  it('remembers an id for twice the signature window by default', async () => {
    const store = memoryStore()
    await createReplayGuard({ store }).firstSeen('evt_1')
    expect(store.ttls).toEqual([600])
  })

  it('lets a vendor retry through after a failed delivery is forgotten', async () => {
    const guard = createReplayGuard({ store: memoryStore() })
    expect(await guard.firstSeen('evt_1', 'ainst_a')).toBe(true)
    await guard.forget('evt_1', 'ainst_a')
    expect(await guard.firstSeen('evt_1', 'ainst_a')).toBe(true)
  })

  it('treats an empty id as a replay, so a delivery with no id is never acted on twice', async () => {
    const guard = createReplayGuard({ store: memoryStore() })
    expect(await guard.firstSeen('')).toBe(false)
  })
})
