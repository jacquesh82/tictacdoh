import { describe, expect, it } from 'vitest'
import {
  BLE_LINK_BYTES_PER_SEC,
  BLE_SAFE_PAYLOAD_BYTES,
  FrameKind,
  INPUT_REDUNDANCY_BLE,
  INPUT_REDUNDANCY_DEFAULT,
  MAX_PLAYERS,
  frame,
  frameBody,
  frameKind,
  inputFrameCodec,
  tickBatchCodec,
} from '../src/index.js'

/**
 * Tests de budget.
 *
 * Ce sont les tests les plus importants du dépôt. Le socle doit relier un
 * iPhone et un Android hors ligne, ce qui impose le BLE, donc ~1500 o/s par
 * lien et ~180 o de charge utile. Si ces assertions tombent, le netcode ne
 * tient plus sur le seul transport qui satisfait cette exigence — et on veut
 * l'apprendre ici, pas sur un appareil en phase 9.
 */

/** Un octet d'input : 8 boutons, ou 4 directions + 4 actions. Cas courant. */
const INPUT_BYTES = 1

/** Tick de référence : ~1 minute de jeu à 30 Hz, donc un varuint sur 2 octets. */
const LATE_TICK = 1800

describe('budget d’un input joueur', () => {
  const codec = inputFrameCodec(INPUT_BYTES)

  it('tient sous 8 octets, redondance maximale comprise', () => {
    const bytes = frame(FrameKind.Input, codec, {
      firstTick: LATE_TICK,
      inputs: new Uint8Array(INPUT_REDUNDANCY_DEFAULT * INPUT_BYTES).fill(0b1010_1010),
    })
    // 1 (type) + 2 (tick) + 1 (compteur) + 3 (inputs) = 7
    expect(bytes.length).toBeLessThanOrEqual(8)
  })

  it('fait l’aller-retour sans perte', () => {
    const value = { firstTick: LATE_TICK, inputs: new Uint8Array([1, 2, 3]) }
    const bytes = frame(FrameKind.Input, codec, value)
    expect(frameKind(bytes)).toBe(FrameKind.Input)
    const back = frameBody(bytes, codec)
    expect(back.firstTick).toBe(LATE_TICK)
    expect(Array.from(back.inputs)).toEqual([1, 2, 3])
  })
})

describe('budget d’un lot de ticks à 4 joueurs', () => {
  const codec = tickBatchCodec(INPUT_BYTES)
  const allSeats = (1 << MAX_PLAYERS) - 1

  it('tient sous 24 octets, redondance maximale comprise', () => {
    const bytes = frame(FrameKind.TickBatch, codec, {
      firstTick: LATE_TICK,
      seatMask: allSeats,
      inputs: new Uint8Array(INPUT_REDUNDANCY_DEFAULT * MAX_PLAYERS * INPUT_BYTES).fill(0xff),
    })
    // 1 (type) + 2 (tick) + 1 (masque) + 1 (compteur) + 12 (inputs) = 17
    expect(bytes.length).toBeLessThanOrEqual(24)
  })

  it('fait l’aller-retour et respecte le masque de sièges', () => {
    // Sièges 0 et 2 seulement : 2 inputs par tick, pas 4.
    const value = { firstTick: 5, seatMask: 0b0101, inputs: new Uint8Array([0xa, 0xb, 0xc, 0xd]) }
    const bytes = frame(FrameKind.TickBatch, codec, value)
    const back = frameBody(bytes, codec)
    expect(back.seatMask).toBe(0b0101)
    expect(Array.from(back.inputs)).toEqual([0xa, 0xb, 0xc, 0xd])
  })

  it('reste sous la MTU BLE même avec des inputs riches', () => {
    // 4 octets d'input, c'est déjà un jeu à visée analogique.
    const rich = tickBatchCodec(4)
    const bytes = frame(FrameKind.TickBatch, rich, {
      firstTick: LATE_TICK,
      seatMask: allSeats,
      inputs: new Uint8Array(INPUT_REDUNDANCY_DEFAULT * MAX_PLAYERS * 4),
    })
    expect(bytes.length).toBeLessThanOrEqual(BLE_SAFE_PAYLOAD_BYTES)
  })
})

describe('budget agrégé sur un lien BLE', () => {
  const inputCodec = inputFrameCodec(INPUT_BYTES)
  const batchCodec = tickBatchCodec(INPUT_BYTES)
  const allSeats = (1 << MAX_PLAYERS) - 1

  /** Octets/s sur le lien le plus chargé — celui de l'hôte, qui parle à tous. */
  function hostLinkBytesPerSec(netHz: number, redundancy: number): number {
    const batch = frame(FrameKind.TickBatch, batchCodec, {
      firstTick: LATE_TICK,
      seatMask: allSeats,
      inputs: new Uint8Array(redundancy * MAX_PLAYERS * INPUT_BYTES),
    }).length
    const input = frame(FrameKind.Input, inputCodec, {
      firstTick: LATE_TICK,
      inputs: new Uint8Array(redundancy * INPUT_BYTES),
    }).length
    // L'hôte diffuse un lot à chacun des 3 autres joueurs et reçoit leurs inputs.
    return (batch + input) * (MAX_PLAYERS - 1) * netHz
  }

  it('tient à 15 Hz avec la redondance BLE, avec 30 % de marge', () => {
    // La marge absorbe les keyframes, le ping et les retransmissions de la
    // couche Channel. Sans elle, le lien sature dès le premier imprévu.
    expect(hostLinkBytesPerSec(15, INPUT_REDUNDANCY_BLE)).toBeLessThanOrEqual(
      BLE_LINK_BYTES_PER_SEC * 0.7,
    )
  })

  it('montre pourquoi la redondance ne peut pas être constante', () => {
    // La redondance par défaut, confortable en WebRTC, mange 72 % d'un lien
    // BLE à la même cadence. C'est la raison d'être de INPUT_REDUNDANCY_BLE :
    // le netcode dérive cette valeur de TransportCaps, il ne la fige pas.
    const overBudget = hostLinkBytesPerSec(15, INPUT_REDUNDANCY_DEFAULT)
    expect(overBudget).toBeGreaterThan(BLE_LINK_BYTES_PER_SEC * 0.7)
    expect(overBudget).toBeLessThanOrEqual(BLE_LINK_BYTES_PER_SEC)
  })

  it('documente que 30 Hz réseau ne passe pas sur BLE', () => {
    // Ce n'est pas un échec : c'est la raison pour laquelle la cadence réseau
    // est découplée de la cadence de simulation. Le jeu tourne à 30 Hz, le
    // réseau à 15 Hz, et chaque lot réseau porte deux ticks de simulation.
    expect(hostLinkBytesPerSec(30, INPUT_REDUNDANCY_BLE)).toBeGreaterThan(BLE_LINK_BYTES_PER_SEC)
  })
})
