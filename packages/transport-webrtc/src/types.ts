import type { Unsubscribe } from '@ttd/core'

/**
 * Voie de mise en relation.
 *
 * Fournie par le transport relayé. WebRTC ne peut pas s'amorcer seul : il faut
 * déjà un canal pour échanger offres et candidats. Le relay sert de tremplin,
 * puis s'efface — une fois le pair à pair établi, plus rien ne transite par
 * lui.
 */
export interface SignalChannel {
  signal(to: number, data: unknown): void
  onSignal(fn: (from: number, data: unknown) => void): Unsubscribe
}

/** Message échangé pendant la mise en relation. */
export type SignalPayload =
  | { readonly kind: 'offer'; readonly sdp: string }
  | { readonly kind: 'answer'; readonly sdp: string }
  | { readonly kind: 'ice'; readonly candidate: unknown }

/**
 * Sous-ensemble de `RTCDataChannel` réellement utilisé.
 *
 * Déclaré à part pour que les tests puissent en fournir une implémentation :
 * Node n'a pas WebRTC, et tirer une pile complète comme dépendance pour
 * vérifier une machine à états serait disproportionné.
 */
export interface DataChannelLike {
  readonly label: string
  readyState: string
  binaryType: string
  send(data: ArrayBufferView | ArrayBuffer | string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** Sous-ensemble de `RTCPeerConnection` réellement utilisé. */
export interface PeerConnectionLike {
  createDataChannel(label: string, options?: Record<string, unknown>): DataChannelLike
  createOffer(): Promise<{ type: string; sdp?: string }>
  createAnswer(): Promise<{ type: string; sdp?: string }>
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(description: { type: string; sdp?: string }): Promise<void>
  addIceCandidate(candidate: unknown): Promise<void>
  close(): void
  onicecandidate: ((event: { candidate: unknown }) => void) | null
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null
  onconnectionstatechange: (() => void) | null
  connectionState: string
}

export type PeerConnectionFactory = () => PeerConnectionLike
