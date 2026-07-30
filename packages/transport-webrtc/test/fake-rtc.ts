import type { DataChannelLike, PeerConnectionLike } from '../src/types.js'

/**
 * Fausse pile WebRTC.
 *
 * Node n'a pas WebRTC, et tirer une implémentation native complète pour
 * vérifier une machine à états serait disproportionné. Cette maquette reproduit
 * ce qui compte ici : l'ordre des messages, le fait qu'un candidat ICE peut
 * précéder la description distante, et l'ouverture asymétrique du canal.
 *
 * Elle ne prouve rien sur la traversée de NAT — cela ne se vérifie que sur de
 * vrais réseaux, dans un navigateur.
 */

const later = (fn: () => void) => void setTimeout(fn, 0)

class FakeChannel implements DataChannelLike {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  peer: FakeChannel | undefined

  constructor(readonly label: string) {}

  open(): void {
    if (this.readyState === 'open') return
    this.readyState = 'open'
    later(() => this.onopen?.())
  }

  send(data: ArrayBufferView | ArrayBuffer | string): void {
    if (this.readyState !== 'open') throw new Error('canal fermé')
    const peer = this.peer
    if (!peer) return
    // Copie et remise différée : un canal qui rappellerait son pair de façon
    // synchrone masquerait les bugs de réentrance.
    const copy =
      typeof data === 'string'
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
              .buffer
          : (data as ArrayBuffer).slice(0)
    later(() => peer.onmessage?.({ data: copy }))
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    later(() => this.onclose?.())
    const peer = this.peer
    this.peer = undefined
    peer?.close()
  }
}

export interface FakeNetworkOptions {
  /** Simule deux NAT symétriques : l'appairage échoue. */
  readonly failToConnect?: boolean
  /** Émet les candidats ICE avant la description distante. */
  readonly candidatesFirst?: boolean
}

/**
 * Deux extrémités appariées. Le premier appel crée l'initiateur, le second le
 * répondeur ; c'est la fabrique qui les met en relation.
 */
export function fakeRtcPair(options: FakeNetworkOptions = {}) {
  const created: FakeConnection[] = []

  class FakeConnection implements PeerConnectionLike {
    connectionState = 'new'
    onicecandidate: ((event: { candidate: unknown }) => void) | null = null
    ondatachannel: ((event: { channel: DataChannelLike }) => void) | null = null
    onconnectionstatechange: (() => void) | null = null

    channel: FakeChannel | undefined
    #remoteSet = false

    constructor() {
      created.push(this)
    }

    get other(): FakeConnection | undefined {
      return created.find((c) => c !== this)
    }

    createDataChannel(label: string): DataChannelLike {
      this.channel = new FakeChannel(label)
      return this.channel
    }

    createOffer(): Promise<{ type: string; sdp?: string }> {
      return Promise.resolve({ type: 'offer', sdp: 'fake-offer' })
    }

    createAnswer(): Promise<{ type: string; sdp?: string }> {
      return Promise.resolve({ type: 'answer', sdp: 'fake-answer' })
    }

    setLocalDescription(): Promise<void> {
      if (options.candidatesFirst) {
        later(() => this.onicecandidate?.({ candidate: { candidate: 'fake-candidate' } }))
      }
      return Promise.resolve()
    }

    setRemoteDescription(description: { type: string }): Promise<void> {
      this.#remoteSet = true

      if (options.failToConnect) {
        later(() => {
          this.connectionState = 'failed'
          this.onconnectionstatechange?.()
        })
        return Promise.resolve()
      }

      if (description.type === 'offer') {
        // Côté répondeur : le canal apparaît quand l'offre est acceptée.
        const initiator = this.other
        const local = new FakeChannel('ttd')
        this.channel = local
        if (initiator?.channel) {
          local.peer = initiator.channel
          initiator.channel.peer = local
        }
        later(() => {
          this.ondatachannel?.({ channel: local })
          local.open()
        })
      } else {
        // Côté initiateur : la réponse reçue ouvre le canal local.
        later(() => this.channel?.open())
      }

      if (!options.candidatesFirst) {
        later(() => this.onicecandidate?.({ candidate: { candidate: 'fake-candidate' } }))
      }
      return Promise.resolve()
    }

    addIceCandidate(candidate: unknown): Promise<void> {
      if (!this.#remoteSet) {
        return Promise.reject(new Error('candidat avant description distante'))
      }
      void candidate
      return Promise.resolve()
    }

    close(): void {
      this.connectionState = 'closed'
      this.channel?.close()
    }
  }

  return {
    factory: () => new FakeConnection(),
    connections: created,
  }
}
