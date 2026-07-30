import { Netcode, type TransportCaps } from '@ttd/core'
import { estimatedBytesPerSec, isPlayableOn } from '@ttd/game-sdk'
import { esquive } from '@ttd/game-esquive'
import { PROFILES, type ProfileName, simStar } from '@ttd/netsim'
import { BLE_CAPS } from '@ttd/transport-ble'
import { LOCAL_CAPS } from '@ttd/transport-local'
import { NEARBY_CAPS } from '@ttd/transport-nearby'
import { WEBRTC_CAPS } from '@ttd/transport-webrtc'
import { WS_CAPS } from '@ttd/transport-ws'
import {
  type ProbeResult,
  type TransportCandidate,
  explainSelection,
  selectTransport,
} from '@ttd/transport-select'
import { capabilities, supportPill } from './capabilities.js'
import { relayUrl, setRelayUrl, relayUrlIsManual } from './app-config.js'
import {
  ALL_TRANSPORTS,
  deviceInfo,
  enabledTransports,
  setTransportEnabled,
} from './device.js'
import { type NearbyPeer, type ScanHandle, startNearbyScan } from './nearby.js'

/** Nom lisible d'un transport, pour les interrupteurs. */
const TRANSPORT_LABELS: Record<string, string> = {
  local: 'Même appareil',
  ws: 'Internet (relay)',
  webrtc: 'Pair à pair (WebRTC)',
  ble: 'Bluetooth',
  nearby: 'Wi-Fi Direct / Multipeer',
}

/** Carte d'identité de l'appareil. */
function deviceCard(): string {
  const d = deviceInfo()
  const ligne = (k: string, v: string) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`
  return [
    ligne('Type', `${d.formFactor} · ${d.runtime}`),
    ligne('Système', d.os),
    ligne('Moteur', d.runtime === 'natif' ? `coquille ${d.platform}` : d.browser),
    ligne('Écran', `${d.screen} · ×${d.pixelRatio}`),
    ligne('Tactile', d.touch ? 'oui' : 'non'),
    ligne('Origine sécurisée', d.secureContext ? 'oui' : 'non — caméra et QR indisponibles'),
    d.cores ? ligne('Cœurs', String(d.cores)) : '',
  ].join('')
}

/** Interrupteurs par moyen de communication. */
function transportToggles(): string {
  const actifs = enabledTransports()
  const dispo = new Map(capabilities().map((row) => [row.kind, row]))
  return ALL_TRANSPORTS.map((kind) => {
    const row = dispo.get(kind)
    const supporte = row ? row.join !== 'non' : true
    const coche = actifs.has(kind) ? 'checked' : ''
    const note = supporte ? '' : ' — indisponible sur cet appareil'
    return `<label class="switch">
      <input type="checkbox" data-transport="${kind}" ${coche} />
      <span><b>${TRANSPORT_LABELS[kind] ?? kind}</b><span class="muted">${note}</span></span>
    </label>`
  }).join('')
}

/** Une ligne de la liste des appareils à proximité. */
function peerRow(peer: NearbyPeer): string {
  const d = peer.distance
  const distance = d
    ? `<b>${d.label}</b> <span class="muted">≈ ${d.meters.toFixed(1)} m (${d.min.toFixed(1)}–${d.max.toFixed(1)}, confiance ${d.confidence})</span>`
    : `<span class="muted">distance inconnue par ce moyen</span>`
  const signal = peer.rssi !== undefined ? ` · ${Math.round(peer.rssi)} dBm` : ''
  return `<li class="seat" style="align-items:flex-start">
    <span class="dot" style="background:var(--accent)"></span>
    <span>
      <b>${peer.name}</b> <span class="pill warn">${peer.via}${signal}</span>
      <div class="muted">${peer.detail ?? ''}</div>
      <div>${distance}</div>
    </span>
  </li>`
}

/**
 * Sonde les transports depuis ce navigateur.
 *
 * Chaque sondage dit ce qui marche *ici et maintenant*, et non ce que
 * l'appareil sait faire en théorie. Les transports natifs sont déclarés
 * injoignables depuis le web, avec la raison : c'est plus utile qu'une absence
 * silencieuse dans la liste.
 */
function browserCandidates(): TransportCandidate[] {
  const rows = new Map(capabilities().map((row) => [row.kind, row]))
  const unavailable = (kind: string, fallback: string): ProbeResult => ({
    reachable: false,
    reason: rows.get(kind as never)?.note ?? fallback,
  })

  return [
    {
      kind: 'local',
      caps: LOCAL_CAPS,
      probe: () => Promise.resolve({ reachable: true, rttMs: 0, peersFound: 1 }),
    },
    {
      kind: 'webrtc',
      caps: WEBRTC_CAPS,
      probe: () =>
        Promise.resolve(
          typeof RTCPeerConnection === 'undefined'
            ? unavailable('webrtc', 'WebRTC absent')
            : // Joignabilité réelle : seule une tentative d'appairage la
              // prouverait. On l'annonce disponible et le repli sur le relay
              // prendra le relais si le NAT s'y oppose.
              { reachable: true, rttMs: WEBRTC_CAPS.rttHintMs, peersFound: 0 },
        ),
    },
    {
      kind: 'ws',
      caps: WS_CAPS,
      probe: () => probeRelay(),
    },
    {
      kind: 'ble',
      caps: BLE_CAPS,
      probe: () => Promise.resolve(unavailable('ble', 'Bluetooth indisponible ici')),
    },
    {
      kind: 'nearby',
      caps: NEARBY_CAPS,
      probe: () => Promise.resolve(unavailable('nearby', 'Wi-Fi Direct réservé au natif')),
    },
  ]
}



/**
 * Sonde le relay en ouvrant réellement une WebSocket.
 *
 * Et non par un `fetch` sur sa page d'état : celui-ci est soumis au CORS, si
 * bien qu'un relay en parfait état de marche était déclaré injoignable. Une
 * page de diagnostic qui annonce un serveur mort alors qu'il répond est pire
 * qu'une absence de diagnostic. La WebSocket, elle, échappe au CORS *et* teste
 * exactement le mécanisme que la partie utilisera.
 */
function probeRelay(timeoutMs = 3000): Promise<ProbeResult> {
  if (typeof WebSocket === 'undefined') {
    return Promise.resolve({ reachable: false, reason: 'WebSocket absent de ce navigateur' })
  }
  return new Promise<ProbeResult>((resolve) => {
    const started = performance.now()
    let socket: WebSocket
    try {
      socket = new WebSocket(relayUrl())
    } catch {
      resolve({ reachable: false, reason: `adresse de relay invalide (${relayUrl()})` })
      return
    }
    const finish = (result: ProbeResult) => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Fermer une socket déjà morte n'a pas à remonter.
      }
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ reachable: false, reason: 'relay sans réponse' }),
      timeoutMs,
    )
    socket.addEventListener('open', () =>
      finish({ reachable: true, rttMs: performance.now() - started, peersFound: 0 }),
    )
    socket.addEventListener('error', () => finish({ reachable: false, reason: 'relay injoignable' }))
  })
}

/** Statistiques d'un lien, telles qu'on les montre au joueur. */
interface LinkQuality {
  samples: number[]
  min: number
  max: number
  mean: number
  jitter: number
  lossPct: number
  bytesPerSec: number
  mtu: number
}

function summarise(samples: number[], lossPct: number, bytesPerSec: number, caps: TransportCaps): LinkQuality {
  if (samples.length === 0) {
    return { samples, min: 0, max: 0, mean: 0, jitter: 0, lossPct, bytesPerSec, mtu: caps.maxPayloadBytes }
  }
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  // Gigue au sens RFC 3550 : moyenne des écarts entre mesures successives.
  // Plus parlant que l'écart-type pour un joueur — c'est l'irrégularité
  // ressentie, pas la dispersion.
  let deltas = 0
  for (let i = 1; i < samples.length; i++) deltas += Math.abs(samples[i]! - samples[i - 1]!)
  const jitter = samples.length > 1 ? deltas / (samples.length - 1) : 0
  return { samples, min, max, mean, jitter, lossPct, bytesPerSec, mtu: caps.maxPayloadBytes }
}

function sparkline(samples: number[], width = 320, height = 48): string {
  if (samples.length < 2) return `<svg class="spark" viewBox="0 0 ${width} ${height}"></svg>`
  const max = Math.max(...samples, 1)
  const step = width / (samples.length - 1)
  const points = samples
    .map((value, i) => `${(i * step).toFixed(1)},${(height - (value / max) * (height - 4) - 2).toFixed(1)}`)
    .join(' ')
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${points}" />
  </svg>`
}

function qualityVerdict(quality: LinkQuality): { label: string; className: string } {
  if (quality.mean === 0) return { label: 'non mesuré', className: 'pill warn' }
  if (quality.lossPct > 5 || quality.mean > 250) return { label: 'mauvais', className: 'pill no' }
  if (quality.jitter > 40 || quality.mean > 120) return { label: 'passable', className: 'pill warn' }
  return { label: 'bon', className: 'pill ok' }
}

/**
 * Mesure un profil de bout en bout dans le simulateur.
 *
 * Sur cette machine, aucun transport réel n'est encore branché : la page
 * mesure donc les profils simulés, ce qui valide déjà la chaîne de mesure
 * elle-même. Sur appareil, les mêmes indicateurs seront alimentés par les
 * vrais liens BLE et Wi-Fi Direct — c'est là que cette page prendra tout son
 * sens, le Bluetooth ne se déboguant pas autrement.
 */
function probeProfile(name: ProfileName) {
  const profile = PROFILES[name]
  const star = simStar({ sessionId: `diag-${name}`, playerCount: 4, profile })
  star.advance(3000)

  // Tous les pairs jouent, pas seulement le hub : mesurer une partie à un
  // joueur puis l'afficher à côté d'un budget calculé pour quatre donnerait
  // deux chiffres incomparables, et une page de diagnostic qui induit en
  // erreur est pire qu'une page absente.
  const netcodes = star.all.map((session) => {
    const netcode = new Netcode({
      session,
      inputBytes: esquive.meta.inputBytes,
      tickRate: esquive.meta.tickRate,
    })
    netcode.start(0)
    star.net.register(netcode)
    return netcode
  })
  const netcode = netcodes[0]!

  const samples: number[] = []
  const startBytes = star.net.stats.bytes
  const startMs = star.net.now()

  for (let step = 0; step < 40; step++) {
    for (const peer of netcodes) peer.submitInput(new Uint8Array([step % 3]))
    star.advance(250)
    const rtt = star.hub.worstRttMs()
    if (rtt > 0) samples.push(rtt)
  }

  const seconds = Math.max(1, (star.net.now() - startMs) / 1000)
  const sent = star.net.stats.sent
  const lossPct = sent > 0 ? (star.net.stats.lost / sent) * 100 : 0
  const bytesPerSec = (star.net.stats.bytes - startBytes) / seconds / 3

  return {
    name,
    profile,
    quality: summarise(samples, lossPct, bytesPerSec, profile.caps),
    playable: isPlayableOn(esquive.meta, profile.caps),
    estimated: estimatedBytesPerSec(esquive.meta, profile.caps),
    netRate: netcode.netRate,
    ticksPerSend: netcode.ticksPerSend,
    inputDelay: netcode.inputDelayTicks,
  }
}

function capabilityTable(): string {
  const rows = capabilities()
    .map((row) => {
      const host = supportPill(row.host)
      const join = supportPill(row.join)
      return `<tr>
        <td><b>${row.label}</b></td>
        <td><span class="${host.className}">${host.text}</span></td>
        <td><span class="${join.className}">${join.text}</span></td>
        <td class="muted" style="white-space:normal">${row.note}</td>
      </tr>`
    })
    .join('')

  return `<div class="scroll-x"><table>
    <thead><tr><th>Transport</th><th>Héberger</th><th>Rejoindre</th><th>Remarque</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function profileCard(probe: ReturnType<typeof probeProfile>): string {
  const { quality } = probe
  const verdict = qualityVerdict(quality)
  const budgetUsed = Math.min(100, (probe.estimated / probe.profile.caps.throughputBytesPerSec) * 100)

  return `<section class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${probe.profile.name}</h2>
      <span class="${verdict.className}">${verdict.label}</span>
    </div>
    ${sparkline(quality.samples)}
    <div class="stat"><span>Aller-retour moyen</span><b>${quality.mean.toFixed(0)} ms</b></div>
    <div class="stat"><span>Min / max</span><b>${quality.min.toFixed(0)} / ${quality.max.toFixed(0)} ms</b></div>
    <div class="stat"><span>Gigue</span><b>${quality.jitter.toFixed(1)} ms</b></div>
    <div class="stat"><span>Perte</span><b>${quality.lossPct.toFixed(1)} %</b></div>
    <div class="stat"><span>Débit mesuré</span><b>${Math.round(quality.bytesPerSec)} o/s</b></div>
    <div class="stat"><span>MTU utile</span><b>${quality.mtu} o</b></div>
    <hr style="border:0;border-top:1px solid var(--line);margin:0.75rem 0" />
    <div class="stat"><span>Cadence réseau</span><b>${probe.netRate} Hz · ${probe.ticksPerSend} tick/envoi</b></div>
    <div class="stat"><span>Délai d’input</span><b>${probe.inputDelay} ticks</b></div>
    <div class="stat"><span>Esquive</span>
      <b><span class="${probe.playable ? 'pill ok' : 'pill no'}">${probe.playable ? 'jouable' : 'trop lourd'}</span></b>
    </div>
    <div class="muted" style="margin:0.5rem 0 0.25rem">
      Budget consommé : ${Math.round(probe.estimated)} o/s sur ${probe.profile.caps.throughputBytesPerSec}
    </div>
    <div class="meter"><span style="width:${budgetUsed.toFixed(0)}%"></span></div>
  </section>`
}

export function renderDiag(root: HTMLElement): () => void {
  root.innerHTML = `
    <h1>Diagnostic réseau</h1>
    <p class="lede">Ce que cet appareil sait faire, et ce que valent les liens disponibles.</p>

    <section class="card" style="margin-bottom:1rem">
      <h2>Cet appareil</h2>
      ${deviceCard()}
    </section>

    <section class="card" style="margin-bottom:1rem">
      <h2>Moyens de communication</h2>
      <p class="muted" style="margin:0 0 0.75rem">
        Ce que vous autorisez. Distinct de ce que l’appareil sait faire : couper
        un moyen disponible sert à vérifier que le repli fonctionne.
      </p>
      <div id="toggles">${transportToggles()}</div>
      <h2 style="margin-top:1.25rem">Adresse du relay</h2>
      <p class="muted" style="margin:0 0 0.5rem">
        Vide = déduite de l’adresse du site. À renseigner dans l’application
        installée, où « localhost » désigne le téléphone lui-même.
      </p>
      <div class="row">
        <input id="relay" placeholder="ws://192.168.1.10:8787" value="${relayUrlIsManual() ? relayUrl() : ''}" />
        <button id="relay-save">Enregistrer</button>
      </div>
      <p class="muted" id="relay-note" style="margin:0.5rem 0 0">Utilisée : ${relayUrl()}</p>
    </section>

    <section class="card" style="margin-bottom:1rem">
      <h2>Capacités détaillées</h2>
      ${capabilityTable()}
      <p class="muted" style="margin:0.75rem 0 0">
        Détecté à partir des API réellement présentes, pas d’une reconnaissance de navigateur.
      </p>
    </section>

    <section class="card" style="margin-bottom:1rem">
      <h2>Moyen de communication retenu</h2>
      <p class="muted" style="margin:0 0 0.75rem">
        Chaque transport est sondé, pas seulement déclaré. Le hors-ligne prime :
        un lien qui ne dépend de personne vaut mieux qu'un lien rapide qui dépend
        d'un serveur.
      </p>
      <p id="pick"><span class="muted">Sondage en cours…</span></p>
      <div class="scroll-x"><table id="ranking">
        <thead><tr><th>Transport</th><th>État</th><th>Pourquoi</th></tr></thead>
        <tbody></tbody>
      </table></div>
    </section>

    <section class="card" style="margin-bottom:1rem">
      <h2>À proximité</h2>
      <p class="muted" style="margin:0 0 0.75rem">
        La distance n’est estimée que par Bluetooth, à partir de la puissance
        reçue. Elle donne un ordre de grandeur, pas une mesure : un corps entre
        les deux appareils suffit à la doubler.
      </p>
      <div class="row">
        <button id="scan" class="primary">Chercher</button>
        <span id="scan-status" class="muted">Aucune recherche lancée.</span>
      </div>
      <ul id="found" class="seats" style="margin-top:0.75rem"></ul>
    </section>

    <h2>Qualité des liens</h2>
    <p class="muted" style="margin:-0.5rem 0 1rem">
      Mesurée sur les profils simulés tant qu’aucun transport réel n’est branché.
      Sur appareil, les mêmes indicateurs seront alimentés par les vrais liens.
    </p>
    <div id="probes" class="grid"></div>
  `

  const probes = root.querySelector<HTMLDivElement>('#probes')!
  const names: ProfileName[] = ['ble', 'wifi', '4g', 'lossy']
  probes.innerHTML = names.map((name) => profileCard(probeProfile(name))).join('')

  void selectTransport(browserCandidates(), { game: esquive.meta }).then((selection) => {
    const pick = root.querySelector<HTMLElement>('#pick')
    const body = root.querySelector<HTMLTableSectionElement>('#ranking tbody')
    if (!pick || !body) return
    pick.textContent = explainSelection(selection)
    body.innerHTML = selection.all
      .map((entry) => {
        const chosen = entry.kind === selection.chosen?.kind
        const pill = chosen ? 'pill ok' : entry.usable ? 'pill warn' : 'pill no'
        const label = chosen ? 'retenu' : entry.usable ? 'repli' : 'écarté'
        return `<tr>
          <td><b>${entry.kind}</b></td>
          <td><span class="${pill}">${label}</span></td>
          <td class="muted" style="white-space:normal">${entry.reason}</td>
        </tr>`
      })
      .join('')
  })

  // --- Interrupteurs de transport ---
  for (const box of root.querySelectorAll<HTMLInputElement>('[data-transport]')) {
    box.addEventListener('change', () => {
      const kind = box.dataset['transport'] as Parameters<typeof setTransportEnabled>[0]
      const actifs = setTransportEnabled(kind, box.checked)
      // Relire l'état plutôt que de faire confiance à la case : couper le
      // dernier moyen est refusé, et la case doit refléter ce refus.
      box.checked = actifs.has(kind)
    })
  }

  // --- Adresse du relay ---
  const relayInput = root.querySelector<HTMLInputElement>('#relay')!
  const relayNote = root.querySelector<HTMLElement>('#relay-note')!
  root.querySelector<HTMLButtonElement>('#relay-save')!.addEventListener('click', () => {
    setRelayUrl(relayInput.value)
    relayNote.textContent = `Utilisée : ${relayUrl()}`
  })

  // --- Découverte ---
  const scan = root.querySelector<HTMLButtonElement>('#scan')!
  const status = root.querySelector<HTMLSpanElement>('#scan-status')!
  const found = root.querySelector<HTMLUListElement>('#found')!
  let handle: ScanHandle | undefined

  const onScan = () => {
    if (handle) {
      handle.stop()
      handle = undefined
      scan.textContent = 'Chercher'
      status.textContent = 'Recherche arrêtée.'
      return
    }
    found.innerHTML = ''
    scan.textContent = 'Arrêter'
    handle = startNearbyScan({
      enabled: enabledTransports(),
      onStatus: (message) => {
        status.textContent = message
      },
      onPeer: (peers) => {
        // Une liste vide sans explication est indiscernable d'une panne : on
        // dit qu'on cherche toujours plutôt que de ne rien afficher.
        found.innerHTML =
          peers.length > 0
            ? peers.map(peerRow).join('')
            : `<li class="muted">Personne pour l’instant. La découverte Bluetooth prend plusieurs secondes.</li>`
      },
    })
  }

  scan.addEventListener('click', onScan)
  return () => {
    handle?.stop()
    scan.removeEventListener('click', onScan)
  }
}
