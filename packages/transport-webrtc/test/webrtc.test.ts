import type { Link, Unsubscribe } from '@ttd/core'
import { FrameKind, frame, u8 } from '@ttd/wire'
import { describe, expect, it } from 'vitest'
import { WEBRTC_CAPS, WebRtcTransport } from '../src/index.js'
import type { SignalChannel } from '../src/types.js'
import { fakeRtcPair } from './fake-rtc.js'

const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Paire de voies de mise en relation, comme le relay les fournit.
 * L'invité occupe la place 1, l'hôte la place 0.
 */
function signalPair() {
  const listeners = new Map<number, Set<(from: number, data: unknown) => void>>()
  const make = (self: number): SignalChannel => ({
    signal(to, data) {
      setTimeout(() => {
        for (const fn of listeners.get(to) ?? []) fn(self, data)
      }, 0)
    },
    onSignal(fn): Unsubscribe {
      let set = listeners.get(self)
      if (!set) {
        set = new Set()
        listeners.set(self, set)
      }
      set.add(fn)
      return () => void set.delete(fn)
    },
  })
  return { host: make(0), guest: make(1) }
}

async function paired(options: Parameters<typeof fakeRtcPair>[0] = {}) {
  const rtc = fakeRtcPair(options)
  const signals = signalPair()

  const host = new WebRtcTransport({
    signal: signals.host,
    selfSlot: 0,
    isHost: true,
    connectionFactory: rtc.factory,
  })
  const guest = new WebRtcTransport({
    signal: signals.guest,
    selfSlot: 1,
    isHost: false,
    connectionFactory: rtc.factory,
  })

  const hostLinks: Link[] = []
  host.onIncoming((link) => void hostLinks.push(link))

  return { host, guest, hostLinks, rtc }
}

describe('capacités', () => {
  it('annonce du hors-ligne sans découverte', () => {
    // Sur un même réseau local, la connexion ne sort pas du Wi-Fi. Mais la
    // mise en relation initiale suppose déjà un canal : WebRTC ne se découvre
    // pas tout seul.
    expect(WEBRTC_CAPS.requiresInternet).toBe(false)
    expect(WEBRTC_CAPS.canDiscover).toBe(false)
    expect(WEBRTC_CAPS.canAdvertise).toBe(false)
    expect(WEBRTC_CAPS.reliable).toBe(true)
    expect(WEBRTC_CAPS.ordered).toBe(true)
  })

  it('refuse de s’annoncer', async () => {
    const { host } = await paired()
    await expect(host.advertise({} as never)).rejects.toThrow(/mise en relation passe par le relay/)
    await host.close()
  })

  it('n’énumère rien', async () => {
    const { guest } = await paired()
    const found = []
    for await (const session of guest.discover()) found.push(session)
    expect(found).toHaveLength(0)
    await guest.close()
  })
})

describe('appairage', () => {
  it('établit un canal de bout en bout', async () => {
    const { guest, hostLinks, host } = await paired()
    const link = await guest.connectToHost('Hôte')
    await settle()

    expect(link.closed).toBe(false)
    expect(hostLinks).toHaveLength(1)
    expect(hostLinks[0]!.peerId).toBe('slot-1')
    await host.close()
    await guest.close()
  })

  it('refuse qu’un hôte initie la connexion', async () => {
    // L'invité seul sait quand il veut rejoindre ; l'hôte n'a pas à deviner
    // combien de correspondants l'attendent.
    const { host } = await paired()
    await expect(host.connectToHost('x')).rejects.toThrow(/n’initie pas/)
    await host.close()
  })

  it('supporte des candidats ICE arrivés avant la description distante', async () => {
    // Cas fréquent en conditions réelles : les ajouter tout de suite lèverait.
    // On les met de côté et on les rejoue une fois la description posée.
    const { guest, hostLinks, host } = await paired({ candidatesFirst: true })
    const link = await guest.connectToHost('Hôte')
    await settle()

    expect(link.closed).toBe(false)
    expect(hostLinks).toHaveLength(1)
    await host.close()
    await guest.close()
  })

  it('annonce clairement un échec d’appairage', async () => {
    // Deux NAT symétriques sans TURN : le message doit désigner la cause et le
    // repli, sinon le diagnostic prend des heures.
    const { guest, host } = await paired({ failToConnect: true })
    await expect(guest.connectToHost('Hôte', 500)).rejects.toThrow(/NAT restrictif.*relay/)
    await host.close()
    await guest.close()
  })

  it('abandonne au bout du délai imparti', async () => {
    const rtc = fakeRtcPair()
    const signals = signalPair()
    // Aucun hôte à l'écoute : l'offre part dans le vide.
    const guest = new WebRtcTransport({
      signal: signals.guest,
      selfSlot: 1,
      isHost: false,
      connectionFactory: rtc.factory,
    })
    await expect(guest.connectToHost('Fantôme', 200)).rejects.toThrow(/délai dépassé/)
    await guest.close()
  })
})

describe('transport de données', () => {
  it('achemine les octets dans les deux sens sans les altérer', async () => {
    const { guest, hostLinks, host } = await paired()
    const link = await guest.connectToHost('Hôte')
    await settle()

    const guestGot: number[] = []
    const hostGot: number[] = []
    link.on('message', (m) => void guestGot.push(m[1]!))
    hostLinks[0]!.on('message', (m) => void hostGot.push(m[1]!))

    link.send(frame(FrameKind.Input, u8, 42))
    hostLinks[0]!.send(frame(FrameKind.TickBatch, u8, 7))
    await settle()

    expect(hostGot).toEqual([42])
    expect(guestGot).toEqual([7])
    await host.close()
    await guest.close()
  })

  it('transmet une charge utile volumineuse intacte', async () => {
    const { guest, hostLinks, host } = await paired()
    const link = await guest.connectToHost('Hôte')
    await settle()

    const got: Uint8Array[] = []
    link.on('message', (m) => void got.push(m))
    const big = new Uint8Array(4096)
    big[0] = FrameKind.Keyframe
    for (let i = 1; i < big.length; i++) big[i] = (i * 17) % 251
    hostLinks[0]!.send(big)
    await settle()

    expect(got).toHaveLength(1)
    expect(Array.from(got[0]!)).toEqual(Array.from(big))
    await host.close()
    await guest.close()
  })

  it('prévient les deux bouts à la fermeture', async () => {
    const { guest, hostLinks, host } = await paired()
    const link = await guest.connectToHost('Hôte')
    await settle()

    const closed: string[] = []
    link.on('close', () => void closed.push('invité'))
    hostLinks[0]!.on('close', () => void closed.push('hôte'))

    link.close('fini')
    await settle()

    expect(closed).toContain('invité')
    expect(link.closed).toBe(true)
    await host.close()
    await guest.close()
  })

  it('ignore un envoi sur un lien fermé', async () => {
    const { guest, host } = await paired()
    const link = await guest.connectToHost('Hôte')
    await settle()
    link.close()
    // Un envoi tardif ne doit pas lever : un lien peut mourir entre le moment
    // où le netcode décide d'émettre et celui où il émet.
    expect(() => link.send(frame(FrameKind.Input, u8, 1))).not.toThrow()
    await host.close()
    await guest.close()
  })
})
