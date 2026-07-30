import { type DistanceEstimate, type TransportKind, estimateDistance, smoothRssi } from '@ttd/core'
import { WsTransport } from '@ttd/transport-ws'
import { relayUrl, hintDefaults } from './app-config.js'
import { playerName } from './home.js'
import { displayName } from './device.js'
import { BleMesh, isNative } from './native.js'

/**
 * Découverte des appareils à portée, tous moyens confondus.
 *
 * Deux chemins très différents réunis derrière une même liste :
 *
 * - **Le réseau local**, via le relay, qui ne connaît que des salles ouvertes.
 *   Aucune notion de distance : « sur le même réseau » peut vouloir dire la
 *   pièce d'à côté comme l'autre bout du bâtiment.
 * - **Le Bluetooth**, qui rapporte une puissance de signal, donc un ordre de
 *   grandeur de distance. C'est le seul moyen qui réponde à « qui est
 *   physiquement près de moi ».
 *
 * Les deux sont présentés ensemble parce que l'utilisateur cherche des
 * *joueurs*, pas des transports — mais chaque entrée dit d'où elle vient, faute
 * de quoi l'absence de distance sur une entrée Wi-Fi passerait pour un bug.
 *
 * ## Chercher ne suffit pas : il faut aussi se montrer
 *
 * Première version de ce module : elle ne faisait que scanner. Deux téléphones
 * ouvrant tous deux la page ne se voyaient donc **jamais** — personne
 * n'émettait, et la liste restait vide sans que rien ne l'explique. Un scan ne
 * trouve que ce qui s'annonce.
 *
 * Chaque appareil s'annonce donc pendant qu'il cherche. L'annonce de
 * diagnostic porte une empreinte réservée, distincte de celle d'une vraie
 * partie : on se rend visible sans pour autant prétendre héberger une salle
 * que personne ne pourrait rejoindre.
 */

/**
 * Empreinte des annonces de diagnostic.
 *
 * Une vraie partie annonce l'empreinte de son code court, ce qui permet de
 * filtrer. Ici on veut être vu de tous, d'où une valeur réservée que le
 * parcours de connexion n'utilisera jamais.
 */
const DIAGNOSTIC_FINGERPRINT = '000000'

export interface NearbyPeer {
  readonly id: string
  readonly name: string
  readonly via: TransportKind
  /** Puissance reçue en dBm, quand le transport la connaît. */
  readonly rssi?: number
  readonly distance?: DistanceEstimate
  /** Précision utile pour l'affichage : salle ouverte ou simple appareil. */
  readonly detail?: string
}

export interface ScanHandle {
  stop(): void
}

export interface ScanOptions {
  readonly onPeer: (peers: NearbyPeer[]) => void
  readonly onStatus: (message: string) => void
  /**
   * État détaillé par moyen.
   *
   * Une ligne d'état unique était écrasée par le message suivant : une erreur
   * Bluetooth disparaissait dès que le relay répondait, et l'utilisateur se
   * retrouvait devant une liste vide sans aucune trace de la cause. Chaque
   * moyen garde donc son propre état, affiché en permanence.
   */
  readonly onTransportState?: (kind: TransportKind, state: TransportState) => void
  /** Moyens que l'utilisateur a laissés actifs. */
  readonly enabled: ReadonlySet<TransportKind>
}

export interface TransportState {
  readonly ok: boolean
  readonly message: string
}

/**
 * Lance une découverte continue.
 *
 * Continue et non ponctuelle : en BLE les appareils apparaissent au fil des
 * annonces, et une recherche « one shot » ne verrait qu'une fraction de ce qui
 * est là. Le RSSI, lui, s'accumule pour être lissé — une seule mesure donne une
 * distance qui saute du simple au double.
 */
export function startNearbyScan(options: ScanOptions): ScanHandle {
  const peers = new Map<string, NearbyPeer>()
  const rssiHistory = new Map<string, number[]>()
  let stopped = false
  const cleanups: Array<() => void> = []

  const publish = () => {
    if (stopped) return
    // Les plus proches d'abord ; ceux sans distance après, car on ne peut pas
    // les situer. Trier par nom les départagerait arbitrairement.
    const list = [...peers.values()].sort((a, b) => {
      if (a.distance && b.distance) return a.distance.meters - b.distance.meters
      if (a.distance) return -1
      if (b.distance) return 1
      return a.name.localeCompare(b.name)
    })
    options.onPeer(list)
  }

  const notePeer = (peer: NearbyPeer) => {
    if (stopped) return
    if (peer.rssi !== undefined) {
      const history = rssiHistory.get(peer.id) ?? []
      history.push(peer.rssi)
      // Fenêtre glissante : au-delà, un appareil qui s'est déplacé resterait
      // ancré sur ses anciennes mesures.
      if (history.length > 12) history.shift()
      rssiHistory.set(peer.id, history)
      const lisse = smoothRssi(history)
      peers.set(peer.id, {
        ...peer,
        ...(lisse === undefined ? {} : { rssi: lisse, distance: estimateDistance(lisse) }),
      })
    } else {
      peers.set(peer.id, peer)
    }
    publish()
  }

  const moyens: string[] = []
  const etat = (kind: TransportKind, ok: boolean, message: string) =>
    options.onTransportState?.(kind, { ok, message })

  // --- Réseau local, par le relay ---
  if (options.enabled.has('ws') || options.enabled.has('webrtc')) {
    moyens.push('réseau local')
    const pollLan = async () => {
      if (stopped) return
      const transport = new WsTransport({ url: relayUrl(), selfName: displayName(playerName()) })
      try {
        const salles = await transport.listRooms(4000)
        etat('ws', true, `relay joignable · ${salles.length} salle(s) ouverte(s)`)
        for (const room of salles) {
          notePeer({
            id: `ws:${room.code}`,
            name: room.roomName || room.hostName,
            via: 'ws',
            detail: `salle ouverte · ${room.playerCount}/${room.maxPlayers} joueurs · hôte ${room.hostName}`,
          })
        }
      } catch (error) {
        if (!stopped) etat('ws', false, `relay injoignable : ${(error as Error).message}`)
      } finally {
        await transport.close()
      }
    }
    void pollLan()
    const timer = globalThis.setInterval(() => void pollLan(), 8000)
    cleanups.push(() => clearInterval(timer))
  }

  // --- Bluetooth, par le plugin natif ---
  if (options.enabled.has('ble') && isNative()) {
    moyens.push('Bluetooth')
    void (async () => {
      try {
        const status = await BleMesh.isAvailable()
        if (!status.available) {
          etat('ble', false, status.reason ?? 'Bluetooth indisponible, raison inconnue')
          return
        }
        const listener = await BleMesh.addListener('discovered', (event) => {
          notePeer({
            id: `ble:${event.deviceId}`,
            name: event.name || 'appareil sans nom',
            via: 'ble',
            ...(event.rssi === undefined ? {} : { rssi: event.rssi }),
            detail: 'Bluetooth, hors réseau',
          })
        })
        cleanups.push(() => void listener.remove())

        const serviceUuid = hintDefaults().bleServiceUuid

        // Sans filtre d'empreinte : ici on veut *voir* ce qui est autour, pas
        // rejoindre une salle précise. Le filtrage par code appartient au
        // parcours de connexion, pas au diagnostic.
        await BleMesh.startScan({ serviceUuid })
        cleanups.push(() => void BleMesh.stopScan())

        // Et se rendre visible, sans quoi deux appareils qui cherchent tous
        // les deux ne se trouveraient jamais.
        if (status.canAdvertise) {
          await BleMesh.startAdvertising({
            serviceUuid,
            fingerprintHex: DIAGNOSTIC_FINGERPRINT,
            localName: displayName(playerName()),
          })
          cleanups.push(() => void BleMesh.stopAdvertising())
          etat('ble', true, `à l’écoute et visible sous « ${displayName(playerName())} »`)
        } else {
          etat('ble', false, 'sait chercher mais pas s’annoncer : verra sans être vu')
        }
      } catch (error) {
        // Le cas le plus instructif : un plugin non enregistré échoue ici avec
        // « not implemented ». Sans cet affichage, l'utilisateur ne voyait
        // qu'une liste vide, indiscernable d'une absence de voisins.
        if (!stopped) etat('ble', false, `plugin injoignable : ${(error as Error).message}`)
      }
    })()
  }

  options.onStatus(
    moyens.length > 0
      ? `Recherche en cours via ${moyens.join(' et ')}…`
      : 'Aucun moyen de découverte actif. Activez-en un ci-dessus.',
  )

  return {
    stop() {
      stopped = true
      for (const fn of cleanups) fn()
    },
  }
}
