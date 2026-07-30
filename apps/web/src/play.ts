import { Netcode, Session, seedFrom } from '@ttd/core'
import { type GamePlugin, GameRuntime, Scoreboard } from '@ttd/game-sdk'
import { resolveGame } from '@ttd/games'
import { LocalTransport } from '@ttd/transport-local'
import { createTicket, generateCode } from '@ttd/join'
import { Rng } from '@ttd/core'
import { hintDefaults, WEB_ORIGIN } from './app-config.js'
import { applyFieldAspect, attachLocalInputs, drawGame, seatColor } from './game-view.js'
import { renderTicket } from './qr.js'

export interface Table {
  readonly sessions: Session[]
  readonly netcodes: Netcode[]
  readonly runtimes: GameRuntime<unknown>[]
  dispose(): void
}

/** Laisse les microtâches s'écouler : la remise des liens est différée. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Monte une partie locale à `playerCount` joueurs.
 *
 * Le mode local emprunte exactement le même chemin de code que le réseau :
 * mêmes sessions, même netcode, même jeu. C'est ce qui en fait le premier banc
 * d'essai utile — un chemin séparé ne prouverait rien.
 */
export async function buildLocalTable(
  sessionId: string,
  playerCount: number,
  plugin: GamePlugin,
): Promise<Table> {
  const transport = new LocalTransport('j1')
  const sessions: Session[] = []

  const host = new Session({ sessionId, selfId: 'j1', selfName: 'Joueur 1', isHub: true })
  transport.onIncoming((link) => host.addPeer(link, link.peerId))
  sessions.push(host)

  for (let i = 2; i <= playerCount; i++) {
    const id = `j${i}`
    const link = transport.seat(id)
    const guest = new Session({ sessionId, selfId: id, selfName: `Joueur ${i}`, isHub: false })
    guest.addPeer(link, 'j1')
    sessions.push(guest)
  }

  // Attendre que le roster soit propagé partout avant de créer quoi que ce
  // soit d'autre. Le hub le publie de façon asynchrone ; démarrer trop tôt fait
  // créer à chaque pair une partie avec un nombre de joueurs différent, ce qui
  // déclenche une boucle de resynchronisation sans fin — l'autorité renvoie un
  // état que les autres refusent aussitôt.
  const deadline = performance.now() + 2000
  for (;;) {
    for (const session of sessions) session.pump(performance.now())
    await settle()
    if (sessions.every((session) => session.playerCount === playerCount)) break
    if (performance.now() > deadline) {
      throw new Error('le roster ne s’est pas propagé : partie non démarrable')
    }
  }

  const seed = seedFrom(sessionId)
  const netcodes: Netcode[] = []
  const runtimes: GameRuntime<unknown>[] = []

  for (const session of sessions) {
    const netcode = new Netcode({
      session,
      inputBytes: plugin.game.meta.inputBytes,
      tickRate: plugin.game.meta.tickRate,
    })
    runtimes.push(new GameRuntime({ game: plugin.game, session, netcode, seed }))
    netcodes.push(netcode)
  }
  for (const netcode of netcodes) netcode.start(0)

  return {
    sessions,
    netcodes,
    runtimes,
    dispose() {
      for (const runtime of runtimes) runtime.dispose()
      for (const netcode of netcodes) netcode.dispose()
      for (const session of sessions) session.close()
      void transport.close()
    },
  }
}

export interface PlayOptions {
  readonly playerCount: number
  /** Mini-jeu choisi sur l'écran d'accueil. */
  readonly gameId: string
}

export function renderPlay(root: HTMLElement, options: PlayOptions): () => void {
  const { plugin, exact } = resolveGame(options.gameId)
  const sessionId = `local-${Date.now().toString(36)}`
  const code = generateCode(new Rng(seedFrom(sessionId)))
  const ticket = createTicket({
    sessionId,
    code,
    hostName: 'Partie locale',
    transports: [{ kind: 'local' }],
  })

  // Plein écran : le terrain prend tout, les informations passent en
  // surimpression. Sur un téléphone, la mise en page en deux colonnes réduisait
  // le jeu à un timbre-poste alors qu'il se joue au doigt.
  document.body.classList.add('playing')
  root.innerHTML = `
    <div class="stage"><canvas id="board"></canvas></div>
    <div class="hud">
      <a href="#/"><button id="quit" aria-label="Quitter la partie">‹ Quitter</button></a>
      <span class="chip">Tick <b id="tick">0</b></span>
      <span class="chip" id="seats-chip"></span>
      <span class="spacer"></span>
      <button id="show-invite">Inviter</button>
    </div>
    <div class="footbar">
      <span id="error-note" class="error"></span>
      <span id="controls"></span>
    </div>

    <div class="sheet" id="invite" hidden>
      <section class="card">
        <h2>Inviter</h2>
        <div class="code">${code}</div>
        <div id="qr"></div>
        <ul id="seats" class="seats" style="margin-top:1rem"></ul>
        <div class="stat"><span>Autorité</span><b id="host">—</b></div>
        <div class="stat"><span>Délai d’input</span><b id="delay">—</b></div>
        <div class="row" style="margin-top:0.75rem">
          <button id="rotate">Manche suivante</button>
          <button id="close-invite" class="primary">Fermer</button>
        </div>
      </section>
    </div>

    <!--
      Résultats de manche. Panneau distinct de l'invitation : on y montre un
      classement cumulé, et l'action attendue n'est pas la même.
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
      </section>
    </div>
  `

  const canvas = root.querySelector<HTMLCanvasElement>('#board')!
  const seatsEl = root.querySelector<HTMLUListElement>('#seats')!
  const controlsEl = root.querySelector<HTMLElement>('#controls')!
  const tickEl = root.querySelector<HTMLElement>('#tick')!
  const hostEl = root.querySelector<HTMLElement>('#host')!
  const delayEl = root.querySelector<HTMLElement>('#delay')!
  const errorNote = root.querySelector<HTMLElement>('#error-note')!
  const rotateButton = root.querySelector<HTMLButtonElement>('#rotate')!
  const results = root.querySelector<HTMLElement>('#results')!
  const resultsTitle = root.querySelector<HTMLElement>('#results-title')!
  const resultsReason = root.querySelector<HTMLElement>('#results-reason')!
  const resultsList = root.querySelector<HTMLOListElement>('#results-list')!
  const nextRound = root.querySelector<HTMLButtonElement>('#next-round')!
  const scoreboard = new Scoreboard()
  const seatsChip = root.querySelector<HTMLElement>('#seats-chip')!
  const sheet = root.querySelector<HTMLElement>('#invite')!
  const openSheet = root.querySelector<HTMLButtonElement>('#show-invite')!
  const closeSheet = root.querySelector<HTMLButtonElement>('#close-invite')!
  const toggleSheet = (visible: boolean) => {
    sheet.hidden = !visible
  }
  openSheet.addEventListener('click', () => toggleSheet(true))
  closeSheet.addEventListener('click', () => toggleSheet(false))

  void renderTicket(root.querySelector<HTMLElement>('#qr')!, ticket, WEB_ORIGIN, hintDefaults())

  applyFieldAspect(canvas, plugin)
  // La scène entière, et non le terrain : voir `attachLocalInputs`.
  const stage = root.querySelector<HTMLElement>('.stage')!
  const inputs = attachLocalInputs(stage, plugin, options.playerCount)
  if (!exact) {
    errorNote.textContent = `Jeu « ${options.gameId} » inconnu — « ${plugin.game.meta.name} » à la place.`
  }
  controlsEl.textContent = inputs.help
  let stopped = false
  let frame = 0
  let timer = 0
  let table: Table | undefined

  void buildLocalTable(sessionId, options.playerCount, plugin)
    .then((built) => {
      if (stopped) {
        built.dispose()
        return
      }
      table = built
      // Point d'inspection en développement : le netcode n'a pas d'interface
      // visible, et une partie qui n'avance pas ne se diagnostique pas
      // autrement qu'en lisant l'état des pairs.
      if (import.meta.env.DEV) {
        ;(globalThis as unknown as Record<string, unknown>)['__ttd'] = built
      }
      const local = built.sessions[0]!
      const localNetcode = built.netcodes[0]!

      seatsChip.textContent = `${local.playerCount} joueur${local.playerCount > 1 ? 's' : ''}`
      seatsEl.innerHTML = local.roster
        .map(
          (peer) =>
            `<li class="seat"><span class="dot" style="background:${seatColor(peer.seat)}"></span>${peer.name}</li>`,
        )
        .join('')

      const names = new Map(local.roster.map((p) => [p.seat, p.name]))

      const showResults = (reason: string) => {
        resultsTitle.textContent = `Manche ${scoreboard.rounds}`
        resultsReason.textContent = reason
        resultsList.innerHTML = scoreboard
          .standings(local.roster.map((p) => p.seat))
          .map(
            (entry) => `<li>
              <span class="dot" style="background:${seatColor(entry.seat)}"></span>
              ${names.get(entry.seat) ?? `siège ${entry.seat}`}
              <span class="pts">${entry.points} pt${entry.points > 1 ? 's' : ''}</span>
            </li>`,
          )
          .join('')
        results.hidden = false
      }

      const watchRound = () => {
        built.runtimes[0]!.on('finished', ({ result }) => {
          scoreboard.record(result)
          showResults(result.reason)
        })
      }
      watchRound()

      /**
       * Relance une manche.
       *
       * L'autorité tourne d'abord : c'est la mesure d'équité, puisque celui qui
       * séquence a un avantage de latence. En local l'écart est nul, mais on
       * emprunte volontairement le même chemin qu'en réseau — un mode qui
       * dévierait ne prouverait plus rien.
       */
      const startRound = () => {
        results.hidden = true
        for (const session of built.sessions) session.rotateHost()
        const seed = seedFrom(`${sessionId}:${scoreboard.rounds}`)
        built.runtimes.forEach((runtime, i) => {
          runtime.dispose()
          built.runtimes[i] = new GameRuntime({
            game: plugin.game,
            session: built.sessions[i]!,
            netcode: built.netcodes[i]!,
            seed,
          })
        })
        for (const netcode of built.netcodes) netcode.start(0)
        watchRound()
      }

      nextRound.addEventListener('click', startRound)
      rotateButton.addEventListener('click', startRound)

      const tickPeriodMs = 1000 / plugin.game.meta.tickRate
      let lastTickMs = performance.now()

      const fail = (error: Error) => {
        stopped = true
        cancelAnimationFrame(frame)
        clearInterval(timer)
        errorNote.textContent = `Partie interrompue : ${error.message}`
        throw error
      }

      /**
       * Simulation et réseau.
       *
       * Pilotés par un minuteur et non par `requestAnimationFrame` : un onglet
       * en arrière-plan ne reçoit plus aucune frame — mesuré à zéro par
       * seconde — et le pair qui fait autorité cesserait alors de séquencer,
       * figeant la partie pour tout le monde. Un minuteur est certes bridé en
       * arrière-plan, mais il continue de tourner.
       */
      const step = () => {
        if (stopped) return
        const now = performance.now()
        try {
          // Retour d'arrière-plan : on ne rattrape pas les minutes perdues,
          // on repart de maintenant. Sinon la boucle passerait de longues
          // secondes à simuler un passé que personne n'a vu.
          if (now - lastTickMs > 1000) lastTickMs = now - tickPeriodMs

          // Les inputs sont échantillonnés à la cadence de simulation, pas à
          // celle de l'affichage : un écran à 120 Hz ne doit pas donner deux
          // fois plus de coups qu'un écran à 60.
          let steps = 0
          while (now - lastTickMs >= tickPeriodMs && steps < 8) {
            lastTickMs += tickPeriodMs
            steps++
            built.netcodes.forEach((netcode, index) => {
              netcode.submitInput(new Uint8Array([inputs.read(index)]))
            })
          }

          for (const session of built.sessions) session.pump(now)
          for (const netcode of built.netcodes) netcode.pump(now)
        } catch (error) {
          fail(error as Error)
        }
      }

      /** Rendu seul : inutile de dessiner quand personne ne regarde. */
      const draw = () => {
        if (stopped) return
        frame = requestAnimationFrame(draw)
        try {
          const courant = built.runtimes[0]!
          drawGame(canvas, plugin, courant.state, local.selfSeat)
          tickEl.textContent = String(courant.tick)
          hostEl.textContent = local.roster.find((p) => p.id === local.host)?.name ?? local.host
          delayEl.textContent = `${localNetcode.inputDelayTicks} ticks`
        } catch (error) {
          fail(error as Error)
        }
      }

      timer = globalThis.setInterval(step, Math.floor(tickPeriodMs)) as unknown as number
      frame = requestAnimationFrame(draw)
    })
    .catch((error: Error) => {
      errorNote.textContent = error.message
    })

  return () => {
    stopped = true
    document.body.classList.remove('playing')
    cancelAnimationFrame(frame)
    clearInterval(timer)
    inputs.dispose()
    table?.dispose()
  }
}
