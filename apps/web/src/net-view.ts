import { Netcode, type Session } from '@ttd/core'
import { type GamePlugin, GameRuntime, Scoreboard } from '@ttd/game-sdk'
import { CATALOGUE, DEFAULT_GAME_ID, type GameOffer, gameById, offers, resolveGame } from '@ttd/games'
import { seedFrom } from '@ttd/core'
import { WEB_ORIGIN, hintDefaults } from './app-config.js'
import { applyFieldAspect, attachLocalInputs, drawGame, seatColor } from './game-view.js'
import { playerName } from './home.js'
import { displayName } from './device.js'
import { RELAY_URL, hostRoom, joinRoom, type NetRoom } from './net.js'
import { renderTicket } from './qr.js'
import { NfcPairing } from '@ttd/nfc'
import { Nfc, isNative } from './native.js'

/** Terrain plein écran, informations en surimpression. */
const SHELL = (title: string) => `
  <div class="stage"><canvas id="board"></canvas></div>
  <div class="hud">
    <a href="#/"><button aria-label="Quitter la partie">‹ ${title}</button></a>
    <span class="chip">Tick <b id="tick">0</b></span>
    <span class="chip" id="state">—</span>
    <span class="chip">RTT <b id="rtt">—</b></span>
    <span class="spacer"></span>
    <button id="start" class="primary">Lancer</button>
    <button id="show-panel">Infos</button>
  </div>
  <div class="footbar">
    <span id="lede">Connexion au relay…</span>
    <span id="error" class="error"></span>
  </div>

  <div class="sheet" id="panel" hidden>
    <section class="card">
      <h2 id="room-title">Partie</h2>
      <ul id="seats" class="seats"></ul>
      <div class="stat"><span>Autorité</span><b id="host">—</b></div>
      <div id="invite" hidden>
        <div class="code" id="code"></div>
        <div id="qr"></div>
      </div>
      <div class="row" style="margin-top:0.75rem">
        <button id="close-panel" class="primary">Fermer</button>
      </div>
    </section>
  </div>

  <!--
    Salle d'attente : ouverte tant que la manche n'a pas commencé. C'est le
    seul endroit où l'on voit qui est là avant de jouer — sans elle, on lance
    une partie sans savoir si les autres sont arrivés.
  -->
  <!--
    Résultats de manche. Séparé de la salle d'attente : on y montre un
    classement, pas une liste d'arrivants, et l'action qu'on y attend n'est pas
    la même.
  -->
  <div class="sheet" id="results" hidden>
    <section class="card">
      <h2 id="results-title">Manche terminée</h2>
      <p class="muted" id="results-reason"></p>
      <ol class="results" id="results-list"></ol>
      <div class="row" style="margin-top:0.5rem">
        <button id="next-round" class="primary">Manche suivante</button>
        <a href="#/"><button>Quitter</button></a>
      </div>
      <p id="results-note" class="muted" style="margin:0.5rem 0 0"></p>
    </section>
  </div>

  <div class="sheet" id="waiting">
    <section class="card">
      <h2 id="waiting-title">Salle d’attente</h2>
      <p class="muted" id="waiting-sub">Connexion…</p>
      <ul id="waiting-seats" class="seats"></ul>
      <!--
        Choix du mini-jeu. Réservé au créateur, comme le lancement : deux
        personnes qui choisiraient en même temps partiraient sur des jeux
        différents, et la partie divergerait dès le premier tick.
      -->
      <div id="game-pick" style="margin-top:1rem">
        <h3 style="margin:0 0 0.5rem;font-size:0.95rem">Jeu</h3>
        <div class="row" id="game-list"></div>
        <p class="muted" id="game-pitch" style="margin:0.5rem 0 0"></p>
      </div>
      <div id="waiting-invite" hidden style="margin-top:1rem">
        <div class="code" id="waiting-code"></div>
        <div id="waiting-qr"></div>
        <!--
          Le NFC ne remplace pas le QR, il le double : approcher deux
          téléphones est plus rapide que viser avec une caméra. Mais seul un
          Android sait présenter, d'où un bouton qui n'apparaît pas partout.
        -->
        <p id="nfc-state" class="muted" style="margin:0.5rem 0 0"></p>
      </div>
      <div class="row" style="margin-top:1rem">
        <button id="waiting-start" class="primary">Lancer la manche</button>
        <a href="#/"><button>Quitter</button></a>
        <button id="waiting-close" hidden>Fermer la salle</button>
      </div>
      <p id="waiting-note" class="muted" style="margin:0.5rem 0 0"></p>
    </section>
  </div>
`

interface Running {
  netcode: Netcode
  runtime: GameRuntime<unknown>
}

/**
 * Écran de partie en réseau.
 *
 * Pilote la même boucle que le mode local : simulation par minuteur, rendu par
 * `requestAnimationFrame`. Le socle ne fait aucune différence entre les deux,
 * ce qui est exactement ce qu'on cherchait à démontrer.
 */
export function renderNet(
  root: HTMLElement,
  mode: 'host' | 'join',
  code?: string,
  roomName = '',
): () => void {
  document.body.classList.add('playing')
  root.innerHTML = SHELL(mode === 'host' ? 'Héberger' : 'Rejoindre')

  const canvas = root.querySelector<HTMLCanvasElement>('#board')!
  const seatsEl = root.querySelector<HTMLUListElement>('#seats')!
  const stateEl = root.querySelector<HTMLElement>('#state')!
  const tickEl = root.querySelector<HTMLElement>('#tick')!
  const hostEl = root.querySelector<HTMLElement>('#host')!
  const rttEl = root.querySelector<HTMLElement>('#rtt')!
  const errorEl = root.querySelector<HTMLElement>('#error')!
  const ledeEl = root.querySelector<HTMLElement>('#lede')!
  const startButton = root.querySelector<HTMLButtonElement>('#start')!
  const waiting = root.querySelector<HTMLElement>('#waiting')!
  const waitingSeats = root.querySelector<HTMLUListElement>('#waiting-seats')!
  const waitingSub = root.querySelector<HTMLElement>('#waiting-sub')!
  const waitingTitle = root.querySelector<HTMLElement>('#waiting-title')!
  const waitingStart = root.querySelector<HTMLButtonElement>('#waiting-start')!
  const waitingClose = root.querySelector<HTMLButtonElement>('#waiting-close')!
  const waitingNote = root.querySelector<HTMLElement>('#waiting-note')!
  const results = root.querySelector<HTMLElement>('#results')!
  const resultsTitle = root.querySelector<HTMLElement>('#results-title')!
  const resultsReason = root.querySelector<HTMLElement>('#results-reason')!
  const resultsList = root.querySelector<HTMLOListElement>('#results-list')!
  const resultsNote = root.querySelector<HTMLElement>('#results-note')!
  const nextRound = root.querySelector<HTMLButtonElement>('#next-round')!
  const gameList = root.querySelector<HTMLElement>('#game-list')!
  const gamePitch = root.querySelector<HTMLElement>('#game-pitch')!
  const nfcState = root.querySelector<HTMLElement>('#nfc-state')!
  let pairing: NfcPairing | undefined
  const scoreboard = new Scoreboard()
  const panel = root.querySelector<HTMLElement>('#panel')!
  root.querySelector<HTMLButtonElement>('#show-panel')!.addEventListener('click', () => {
    panel.hidden = false
  })
  root.querySelector<HTMLButtonElement>('#close-panel')!.addEventListener('click', () => {
    panel.hidden = true
  })

  /**
   * Mini-jeu de la manche.
   *
   * Choisi par le créateur de la salle ; les autres l'apprennent par l'ordre de
   * lancement, qui porte déjà l'identifiant du jeu. Personne ne le devine donc
   * localement — c'est ce qui garantit que tout le monde simule le même jeu.
   */
  let plugin: GamePlugin = resolveGame(DEFAULT_GAME_ID).plugin

  // La scène entière capte le doigt, et non le terrain : voir
  // `attachLocalInputs`. Le câblage se refait à chaque changement de jeu,
  // puisque les actions ne sont pas les mêmes d'un jeu à l'autre.
  const stage = root.querySelector<HTMLElement>('.stage')!
  let inputs = attachLocalInputs(stage, plugin, 1)

  /**
   * Input local, au format du jeu courant.
   *
   * Les actions tiennent sur un entier ; on l'étale sur le nombre d'octets que
   * le jeu déclare, en petit-boutien. Émettre un seul octet quand le jeu en
   * attend deux ferait échouer chaque envoi sur une erreur de longueur.
   */
  const inputBytes = (): Uint8Array => {
    const bits = inputs.read(0)
    const bytes = new Uint8Array(plugin.game.meta.inputBytes)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (bits >>> (i * 8)) & 0xff
    return bytes
  }

  const useGame = (next: GamePlugin) => {
    if (next === plugin) return
    plugin = next
    inputs.dispose()
    inputs = attachLocalInputs(stage, plugin, 1)
    applyFieldAspect(canvas, plugin)
    renderGamePick()
  }

  applyFieldAspect(canvas, plugin)

  let stopped = false
  let frame = 0
  let timer = 0
  let disposeRoom: (() => Promise<void>) | undefined
  let closeRoom: (() => Promise<void>) | undefined
  let session: Session | undefined
  let running: Running | undefined
  /** Netcode prêt mais pas encore en manche. */
  let pending: Netcode | undefined
  let linkKind = '—'

  /**
   * Liste des jeux offerts.
   *
   * Ce qui ne passe pas sur le lien courant est grisé plutôt que masqué : un
   * jeu qui disparaît sans explication laisse croire à un bug, alors qu'un jeu
   * grisé avec sa raison apprend au joueur ce que son lien peut porter.
   */
  const renderGamePick = () => {
    const proprietaire = session?.isHub ?? mode === 'host'
    const caps = session?.linkCaps
    // Sans lien encore établi, on ne peut rien exclure : tout est proposé, et
    // la confrontation aux capacités se fera dès que la session existe.
    const liste: GameOffer[] = caps
      ? offers(caps)
      : CATALOGUE.map((entry) => ({ plugin: entry, playable: true }))

    gameList.innerHTML = liste
      .map((offer) => {
        const choisi = offer.plugin === plugin
        const bloque = !offer.playable || !proprietaire
        return `<button data-game="${offer.plugin.game.meta.id}"
          class="${choisi ? 'primary' : ''}" ${bloque ? 'disabled' : ''}>
          ${offer.plugin.game.meta.name}
        </button>`
      })
      .join('')

    for (const button of gameList.querySelectorAll<HTMLButtonElement>('[data-game]')) {
      button.addEventListener('click', () => {
        const found = gameById(button.dataset['game'] ?? '')
        if (found) useGame(found)
      })
    }

    const empeche = liste.find((offer) => offer.plugin === plugin && !offer.playable)
    gamePitch.textContent = empeche?.reason ?? plugin.pitch
  }

  const seatList = (): string => {
    if (!session) return ''
    return session.roster
      .map((peer) => {
        const moi = peer.id === session!.selfId ? ' (vous)' : ''
        return `<li class="seat"><span class="dot" style="background:${seatColor(peer.seat)}"></span>${peer.name}${moi}</li>`
      })
      .join('')
  }

  const refreshSeats = () => {
    if (!session) return
    const html = seatList()
    seatsEl.innerHTML = html
    if (!waiting.hidden) {
      waitingSeats.innerHTML = html
      // C'est le créateur de la salle qui lance, pas l'autorité de
      // séquencement : celle-ci tourne à chaque manche, et le bouton sauterait
      // d'un joueur à l'autre sans raison compréhensible.
      const proprietaire = session.isHub
      // Fermer n'est offert qu'au créateur : sans cela, la salle reste dans la
      // liste jusqu'à son expiration et encombre les autres joueurs.
      waitingClose.hidden = !proprietaire
      waitingStart.disabled = !proprietaire
      waitingStart.textContent = proprietaire ? 'Lancer la manche' : 'En attente du créateur'
      startButton.disabled = !proprietaire
      waitingSub.textContent = proprietaire
        ? `${session.playerCount} joueur(s) · ${linkKind}`
        : `${session.playerCount} joueur(s) · ${linkKind} · en attente du créateur`
      renderGamePick()
    }
  }

  /**
   * Branche la salle d'attente sur les événements de session.
   *
   * Et non sur la boucle de rendu : celle-ci s'arrête dès que l'onglet passe
   * en arrière-plan, et la liste des joueurs restait alors figée sur
   * « Connexion… » alors que tout le monde était déjà là. Une liste d'attente
   * n'a aucune raison de dépendre du rythme d'affichage.
   */
  const watchRoster = (s: Session) => {
    const off = [
      s.on('peer-joined', refreshSeats),
      s.on('peer-left', refreshSeats),
      s.on('host-changed', refreshSeats),
    ]
    refreshSeats()
    return () => {
      for (const fn of off) fn()
    }
  }

  let unwatch: (() => void) | undefined

  /**
   * Prépare le netcode dès que la session existe.
   *
   * Il doit tourner **avant** la manche pour recevoir l'ordre de départ de
   * l'hôte : le créer au moment de jouer ferait manquer cet ordre à tous ceux
   * qui ne l'ont pas donné.
   */
  const armNetcode = (s: Session) => {
    const netcode = new Netcode({
      session: s,
      inputBytes: plugin.game.meta.inputBytes,
      tickRate: plugin.game.meta.tickRate,
      // Le jeu de la manche n'est connu qu'au lancement pour ceux qui ne
      // l'ont pas choisi : le netcode adopte alors son format d'input.
      gameParams: (id) => {
        const found = gameById(id)
        return found ? { inputBytes: found.game.meta.inputBytes, tickRate: found.game.meta.tickRate } : undefined
      },
    })
    pending = netcode

    netcode.on('match-start', ({ seed, gameId }) => {
      running?.runtime.dispose()
      // Le jeu vient de l'ordre de lancement, jamais du choix local : c'est ce
      // qui garantit que tous les pairs simulent le même.
      const { plugin: choisi, exact } = resolveGame(gameId)
      if (!exact) {
        errorEl.textContent = `Jeu « ${gameId} » inconnu ici — mettez l’application à jour.`
      }
      useGame(choisi)
      const runtime = new GameRuntime({ game: plugin.game, session: s, netcode, seed })
      running = { netcode, runtime }
      waiting.hidden = true
      results.hidden = true
      startButton.disabled = true
      waitingStart.disabled = true

      runtime.on('finished', ({ result }) => {
        // Le classement se déduit de la simulation, identique chez tous : les
        // points n'ont donc pas à circuler. Deux sources de vérité pour une même
        // donnée finiraient par diverger.
        scoreboard.record(result)
        showResults(result.reason)
      })
    })
  }

  /** L'hôte lance pour toute la table. Les autres suivent. */
  const startMatch = () => {
    if (!session || running || !pending) return
    if (!session.isHub) {
      waitingSub.textContent = 'En attente du créateur de la salle…'
      return
    }
    pending.startMatch({
      seed: seedFrom(`${session.sessionId}:0`),
      gameId: plugin.game.meta.id,
    })
  }

  // Relu à chaque tour de boucle : la cadence dépend du jeu, qui peut changer
  // d'une manche à l'autre.
  const tickPeriod = () => 1000 / plugin.game.meta.tickRate
  let lastTickMs = performance.now()

  const step = () => {
    if (stopped || !session) return
    const now = performance.now()
    try {
      const tickPeriodMs = tickPeriod()
      if (now - lastTickMs > 1000) lastTickMs = now - tickPeriodMs
      let steps = 0
      while (now - lastTickMs >= tickPeriodMs && steps < 8) {
        lastTickMs += tickPeriodMs
        steps++
        running?.netcode.submitInput(inputBytes())
      }
      session.pump(now)
      // Le netcode est pompé même hors manche : c'est ainsi qu'il reçoit
      // l'ordre de départ de l'hôte.
      ;(running?.netcode ?? pending)?.pump(now)
    } catch (error) {
      errorEl.textContent = `Interrompu : ${(error as Error).message}`
      stopped = true
    }
  }

  const draw = () => {
    if (stopped) return
    frame = requestAnimationFrame(draw)
    if (!session) return
    if (running) drawGame(canvas, plugin, running.runtime.state, session.selfSeat)
    tickEl.textContent = String(running?.runtime.tick ?? 0)
    hostEl.textContent = session.roster.find((p) => p.id === session!.host)?.name ?? session.host
    const rtt = session.worstRttMs()
    rttEl.textContent = rtt > 0 ? `${Math.round(rtt)} ms` : '—'
    stateEl.textContent = `${session.playerCount} j · ${linkKind}`
    refreshSeats()
  }

  const showResults = (reason: string) => {
    if (!session) return
    const noms = new Map(session.roster.map((p) => [p.seat, p.name]))
    const classement = scoreboard.standings(session.roster.map((p) => p.seat))

    resultsTitle.textContent = `Manche ${scoreboard.rounds}`
    resultsReason.textContent = reason
    resultsList.innerHTML = classement
      .map((entry) => {
        const moi = noms.get(entry.seat) === session!.selfName ? ' (vous)' : ''
        return `<li>
          <span class="dot" style="background:${seatColor(entry.seat)}"></span>
          ${noms.get(entry.seat) ?? `siège ${entry.seat}`}${moi}
          <span class="pts">${entry.points} pt${entry.points > 1 ? 's' : ''}</span>
        </li>`
      })
      .join('')

    const proprietaire = session.isHub
    nextRound.disabled = !proprietaire
    nextRound.textContent = proprietaire ? 'Manche suivante' : 'En attente du créateur'
    // La rotation a déjà eu lieu au lancement précédent : on annonce qui
    // séquencera la prochaine, pour que le joueur comprenne que le rôle tourne.
    const suivant = session.hostOrder[(session.rotations + 1) % Math.max(1, session.hostOrder.length)]
    const nomSuivant = session.roster.find((p) => p.id === suivant)?.name
    resultsNote.textContent = nomSuivant ? `Prochaine autorité : ${nomSuivant}` : ''
    results.hidden = false
  }

  const startRound = () => {
    if (!session || !pending || !session.isHub) return
    // L'autorité tourne entre les manches : c'est la mesure d'équité, puisque
    // celui qui séquence a un avantage de latence sur les autres.
    session.rotateHost()
    pending.startMatch({
      seed: seedFrom(`${session.sessionId}:${scoreboard.rounds}`),
      gameId: plugin.game.meta.id,
    })
  }

  nextRound.addEventListener('click', startRound)

  /** La salle a disparu sous nos pieds : le dire plutôt que de figer l'écran. */
  const watchClosure = (s: Session) =>
    s.on('peer-left', () => {
      if (s.playerCount > 1 || s.isHub) return
      waitingNote.textContent = 'La salle a été fermée par son créateur.'
      waitingStart.disabled = true
    })

  const boot = async () => {
    if (mode === 'host') {
      const room: NetRoom = await hostRoom(RELAY_URL(), displayName(playerName()), roomName)
      disposeRoom = room.dispose
      closeRoom = room.closeRoom
      session = room.session
      ledeEl.textContent = `« ${room.roomName} » ouverte. Partagez le code ou le QR.`
      waitingTitle.textContent = room.roomName
      const invite = root.querySelector<HTMLElement>('#invite')!
      invite.hidden = false
      root.querySelector<HTMLElement>('#code')!.textContent = room.code
      void renderTicket(root.querySelector<HTMLElement>('#qr')!, room.ticket, WEB_ORIGIN, hintDefaults())

      // Présenter le ticket en NFC pendant toute la vie de la salle : c'est
      // passif, sans coût, et ça évite au joueur d'avoir à y penser.
      if (isNative()) {
        pairing = new NfcPairing(Nfc)
        void pairing
          .present(room.ticket, WEB_ORIGIN)
          .then(() => {
            nfcState.textContent = 'Ticket présenté en NFC : approchez un téléphone.'
          })
          .catch((error: Error) => {
            // Un iPhone tombe ici, et c'est normal : le dire évite de croire
            // à une panne.
            nfcState.textContent = error.message
          })
      }

      const waitingInvite = root.querySelector<HTMLElement>('#waiting-invite')!
      waitingInvite.hidden = false
      root.querySelector<HTMLElement>('#waiting-code')!.textContent = room.code
      void renderTicket(
        root.querySelector<HTMLElement>('#waiting-qr')!,
        room.ticket,
        WEB_ORIGIN,
        hintDefaults(),
      )
      session.on('peer-joined', () => {
        linkKind = [...room.linkKinds.values()].join(', ') || '—'
      })
      armNetcode(session)
      unwatch = watchRoster(session)
      return
    }

    if (!code) throw new Error('code manquant')
    const joined = await joinRoom(
      RELAY_URL(),
      code,
      displayName(playerName()),
    )
    disposeRoom = joined.dispose
    session = joined.session
    linkKind = joined.kind
    waitingTitle.textContent = joined.roomName
    ledeEl.textContent = `« ${joined.roomName} » — connecté par ${joined.kind}.`
    armNetcode(session)
    const offRoster = watchRoster(session)
    const offClosure = watchClosure(session)
    unwatch = () => {
      offRoster()
      offClosure()
    }
  }

  void boot()
    .then(() => {
      timer = globalThis.setInterval(step, Math.floor(tickPeriod())) as unknown as number
      refreshSeats()
      frame = requestAnimationFrame(draw)
      if (import.meta.env.DEV) {
        ;(globalThis as unknown as Record<string, unknown>)['__ttdNet'] = {
          get session() {
            return session
          },
          get running() {
            return running
          },
          get linkKind() {
            return linkKind
          },
        }
      }
    })
    .catch((error: Error) => {
      waitingSub.textContent = 'Connexion impossible.'
      ledeEl.textContent = 'Connexion impossible.'
      errorEl.textContent = `${error.message} — le relay est-il lancé ? (npm run relay)`
    })

  startButton.addEventListener('click', startMatch)
  waitingStart.addEventListener('click', startMatch)

  waitingClose.addEventListener('click', () => {
    waitingClose.disabled = true
    waitingNote.textContent = 'Fermeture…'
    void closeRoom?.().then(() => {
      globalThis.location.hash = '#/'
    })
  })

  return () => {
    stopped = true
    document.body.classList.remove('playing')
    cancelAnimationFrame(frame)
    clearInterval(timer)
    inputs.dispose()
    unwatch?.()
    running?.runtime.dispose()
    pending?.dispose()
    // Sans cela, la puce continuerait de présenter le ticket d'une salle
    // fermée : un joueur qui approche son téléphone rejoindrait le néant.
    void pairing?.dispose()
    void disposeRoom?.()
  }
}
