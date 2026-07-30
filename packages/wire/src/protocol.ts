import type { Codec } from './codec.js'
import { fail } from './errors.js'
import { Reader } from './reader.js'
import { Writer } from './writer.js'

/**
 * Registre des types de trame du socle. Numéros figés : ils voyagent sur le
 * fil, on n'insère jamais au milieu, on ajoute en fin.
 */
export const FrameKind = {
  Hello: 0,
  Welcome: 1,
  Ping: 2,
  Pong: 3,
  /** client -> hôte : inputs locaux, avec redondance sur les ticks récents */
  Input: 4,
  /** hôte -> tous : inputs ordonnés de tous les joueurs pour une plage de ticks */
  TickBatch: 5,
  /** hôte -> un/tous : état complet (arrivée en cours, resynchronisation) */
  Keyframe: 6,
  /** tous -> hôte : empreinte d'état, détection de désync */
  StateHash: 7,
  /** passation d'autorité entre deux mini-jeux */
  HostHandoff: 8,
  Bye: 9,
  /**
   * Réacheminement par le hub.
   *
   * Le hub est le centre physique de l'étoile (imposé par le transport), l'hôte
   * est l'autorité de séquencement (librement rotative). Quand les deux ne
   * coïncident pas, l'hôte ne peut pas joindre tout le monde directement : ses
   * trames transitent par le hub sous cette enveloppe. C'est ce qui rend la
   * rotation d'hôte possible en BLE.
   */
  Route: 10,
  /**
   * Demande de resynchronisation.
   *
   * Émise par un pair qui constate un trou infranchissable entre son dernier
   * tick simulé et ce que l'hôte diffuse — typiquement un joueur qui rejoint
   * une manche déjà commencée. Sans elle, ce pair attendrait indéfiniment un
   * tick que l'hôte a séquencé avant son arrivée et ne réémettra jamais.
   */
  Resync: 11,
  /**
   * Lancement d'une manche, décidé par l'hôte.
   *
   * Porte la graine : sans elle, chaque pair tirerait la sienne et les
   * obstacles ne tomberaient pas aux mêmes endroits. La dériver de
   * l'identifiant de session marcherait pour la première manche seulement — il
   * faut une graine neuve à chaque nouvelle partie.
   */
  MatchStart: 12,
} as const

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind]

/** Nombre maximum de joueurs simultanés dans une session. */
export const MAX_PLAYERS = 4

/**
 * Enveloppe utile d'un lien BLE, en octets. ATT MTU négocié à 185 moins
 * l'en-tête ATT et une marge : au-delà, la pile fragmente et la latence
 * devient imprévisible.
 */
export const BLE_SAFE_PAYLOAD_BYTES = 180

/**
 * Débit soutenable d'un lien BLE, en octets par seconde. Volontairement
 * conservateur : c'est le chiffre de référence du budget du socle, parce que
 * le BLE est le seul chemin hors-ligne entre iOS et Android.
 */
export const BLE_LINK_BYTES_PER_SEC = 1500

/**
 * Redondance des inputs : nombre de ticks réémis à chaque envoi.
 *
 * Le socle ne retransmet pas les inputs perdus, il les renvoie d'avance. Sur un
 * lien lent, un aller-retour d'accusé coûte plus cher en latence que quelques
 * octets de redondance, et un input arrivé trop tard ne sert à rien.
 *
 * La valeur n'est pas constante : elle se paie en bande passante et le BLE n'en
 * a pas à revendre. Le netcode la dérive de `TransportCaps` — voir les tests de
 * budget, où 3 ticks à 15 Hz consomment déjà 72 % d'un lien BLE.
 */
export const MAX_INPUT_REDUNDANCY = 4

/** Redondance sur lien confortable (WebRTC, WebSocket, Nearby). */
export const INPUT_REDUNDANCY_DEFAULT = 3

/** Redondance sur lien BLE : 2 ticks couvrent une perte isolée dans le budget. */
export const INPUT_REDUNDANCY_BLE = 2

/** Inputs locaux d'un joueur, sur une plage de ticks consécutifs. */
export interface InputFrame {
  /** Tick du premier input du lot. */
  firstTick: number
  /** Inputs concaténés, `count * inputBytes` octets. */
  inputs: Uint8Array
}

/** Inputs de tous les joueurs, ordonnés par l'hôte. */
export interface TickBatchFrame {
  firstTick: number
  /** Bit `i` à 1 si le siège `i` a un input dans ce lot. */
  seatMask: number
  /** Inputs concaténés : pour chaque tick, les sièges présents dans l'ordre. */
  inputs: Uint8Array
}

function seatCount(mask: number): number {
  let n = 0
  for (let bit = 0; bit < MAX_PLAYERS; bit++) if (mask & (1 << bit)) n++
  return n
}

/**
 * Codec des inputs d'un joueur.
 *
 * `inputBytes` vient de la configuration du mini-jeu et n'est pas transmis :
 * les deux pairs le connaissent déjà. Sur BLE chaque octet compte, et un champ
 * de taille déductible du contexte n'a pas sa place sur le fil.
 */
export function inputFrameCodec(inputBytes: number): Codec<InputFrame> {
  if (!Number.isInteger(inputBytes) || inputBytes < 1) {
    fail(`inputBytes doit être un entier >= 1, reçu ${inputBytes}`)
  }
  return {
    name: `InputFrame(${inputBytes})`,
    write(w: Writer, v: InputFrame) {
      if (v.inputs.length % inputBytes !== 0) {
        fail(`inputs de ${v.inputs.length} octets non divisibles par ${inputBytes}`)
      }
      const count = v.inputs.length / inputBytes
      if (count > MAX_INPUT_REDUNDANCY) fail(`lot d'inputs trop long: ${count} ticks`)
      w.varuint(v.firstTick)
      w.u8(count)
      w.raw(v.inputs)
    },
    read(r: Reader) {
      const firstTick = r.varuint()
      const count = r.u8()
      if (count > MAX_INPUT_REDUNDANCY) fail(`lot d'inputs trop long: ${count} ticks`)
      return { firstTick, inputs: r.raw(count * inputBytes).slice() }
    },
  }
}

/** Codec du lot de ticks diffusé par l'hôte. */
export function tickBatchCodec(inputBytes: number): Codec<TickBatchFrame> {
  if (!Number.isInteger(inputBytes) || inputBytes < 1) {
    fail(`inputBytes doit être un entier >= 1, reçu ${inputBytes}`)
  }
  return {
    name: `TickBatchFrame(${inputBytes})`,
    write(w: Writer, v: TickBatchFrame) {
      if (v.seatMask < 0 || v.seatMask >= 1 << MAX_PLAYERS) {
        fail(`masque de sièges invalide: ${v.seatMask}`)
      }
      const perTick = seatCount(v.seatMask) * inputBytes
      if (perTick === 0) {
        if (v.inputs.length !== 0) fail('masque vide mais inputs non vides')
      } else if (v.inputs.length % perTick !== 0) {
        fail(`inputs de ${v.inputs.length} octets non divisibles par ${perTick}`)
      }
      const count = perTick === 0 ? 0 : v.inputs.length / perTick
      w.varuint(v.firstTick)
      w.u8(v.seatMask)
      w.u8(count)
      w.raw(v.inputs)
    },
    read(r: Reader) {
      const firstTick = r.varuint()
      const seatMask = r.u8()
      if (seatMask >= 1 << MAX_PLAYERS) fail(`masque de sièges invalide: ${seatMask}`)
      const count = r.u8()
      const perTick = seatCount(seatMask) * inputBytes
      return { firstTick, seatMask, inputs: r.raw(count * perTick).slice() }
    },
  }
}

/**
 * L'octet de tête porte le type sur les 5 bits bas et des drapeaux sur les
 * 3 bits hauts.
 *
 * Loger les drapeaux ici plutôt que dans un octet dédié n'est pas de
 * l'économie de bout de chandelle : un octet par message coûte ~7 % du budget
 * BLE à 15 Hz. Le partage est 5/3 et non 4/4 parce qu'un seul drapeau est
 * prévu, alors que le registre des types a vocation à s'étoffer avec le
 * catalogue — 32 types laissent de la marge, 16 seraient déjà à moitié pleins.
 */
export const KIND_MASK = 0x1f
export const FLAG_MASK = 0xe0

/** Le message est un fragment : l'en-tête est suivi de msgId/index/total. */
export const FLAG_FRAGMENT = 0x20

/** Une trame prête à partir sur un lien : type + charge utile. */
export function frame<T>(kind: FrameKind, codec: Codec<T>, value: T): Uint8Array {
  const w = new Writer(64)
  w.u8(kind)
  codec.write(w, value)
  return w.finish()
}

/** Lit le type d'une trame sans décoder sa charge utile ni ses drapeaux. */
export function frameKind(buf: Uint8Array): FrameKind {
  const head = new Reader(buf).u8()
  const kind = head & KIND_MASK
  const known = Object.values(FrameKind).includes(kind as FrameKind)
  if (!known) fail(`type de trame inconnu: ${kind}`)
  return kind as FrameKind
}

/** Lit les drapeaux de l'octet de tête. */
export function frameFlags(buf: Uint8Array): number {
  return new Reader(buf).u8() & FLAG_MASK
}

/** Décode la charge utile d'une trame dont le type a déjà été lu. */
export function frameBody<T>(buf: Uint8Array, codec: Codec<T>): T {
  const r = new Reader(buf)
  r.u8()
  const value = codec.read(r)
  if (!r.exhausted) fail(`${r.remaining} octet(s) inattendu(s) après ${codec.name}`)
  return value
}
